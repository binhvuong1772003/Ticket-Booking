import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventService } from './event.service';
import { EventsRepository } from '../infrastructure/events.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

const published = { id: 'e1', ownerId: 'u1', status: 'PUBLISHED' };
const draft = { id: 'e2', ownerId: 'u1', status: 'DRAFT' };

describe('EventService.findById visibility', () => {
  let service: EventService;
  const findById = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: EventsRepository, useValue: { findById } },
        { provide: EventsSessionRepository, useValue: {} },
        { provide: OutboxProcessor, useValue: {} },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('returns a published event to anonymous viewers', async () => {
    findById.mockResolvedValue(published);
    await expect(service.findById('64b64c0000000000000000e1')).resolves.toBe(
      published,
    );
  });

  it('hides inactive ticket types from public event detail', async () => {
    const active = { id: 'ticket-active', status: 'ACTIVE' };
    const inactive = { id: 'ticket-inactive', status: 'INACTIVE' };
    findById.mockResolvedValue({
      ...published,
      sessions: [
        { id: 'session-1', status: 'SCHEDULED', ticketTypes: [active, inactive] },
      ],
    });

    const event = await service.findById('64b64c0000000000000000e1');

    expect(event.sessions?.[0].ticketTypes).toEqual([active]);
  });

  it('keeps inactive ticket types visible to the event owner', async () => {
    const active = { id: 'ticket-active', status: 'ACTIVE' };
    const inactive = { id: 'ticket-inactive', status: 'INACTIVE' };
    findById.mockResolvedValue({
      ...published,
      sessions: [
        { id: 'session-1', status: 'SCHEDULED', ticketTypes: [active, inactive] },
      ],
    });

    const event = await service.findById('64b64c0000000000000000e1', {
      sub: 'u1',
    });

    expect(event.sessions?.[0].ticketTypes).toEqual([active, inactive]);
  });

  it('hides non-published events from anonymous viewers', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('returns a draft to its owner', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2', { sub: 'u1' }),
    ).resolves.toBe(draft);
  });

  it('returns a draft to an admin', async () => {
    findById.mockResolvedValue(draft);
    await expect(
      service.findById('64b64c0000000000000000e2', {
        sub: 'other',
        role: 'ADMIN',
      }),
    ).resolves.toBe(draft);
  });

  it('rejects malformed ids without hitting the repository', async () => {
    await expect(service.findById('not-an-id')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('EventService.findPublishedPage discovery summary', () => {
  let service: EventService;
  const findPublishedPage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'));
    const module = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: EventsRepository, useValue: { findPublishedPage } },
        { provide: EventsSessionRepository, useValue: {} },
        { provide: OutboxProcessor, useValue: {} },
      ],
    }).compile();
    service = module.get(EventService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the earliest eligible session and its currently open minimum price', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    findPublishedPage.mockResolvedValue([
      {
        id: 'event-1',
        status: 'PUBLISHED',
        sessions: [
          {
            id: 'session-later',
            status: 'SCHEDULED',
            startsAt: new Date('2026-10-03T10:00:00.000Z'),
            city: 'Hanoi',
            currency: 'VND',
            ticketTypes: [
              { status: 'ACTIVE', price: 500, salesStartAt: null },
            ],
          },
          {
            id: 'session-first',
            status: 'SCHEDULED',
            startsAt: new Date('2026-10-01T10:00:00.000Z'),
            city: 'Hanoi',
            currency: 'VND',
            ticketTypes: [
              { status: 'INACTIVE', price: 1, salesStartAt: null },
              {
                status: 'ACTIVE',
                price: 900,
                salesStartAt: new Date('2026-09-29T10:00:00.000Z'),
              },
              {
                status: 'ACTIVE',
                price: 100,
                salesStartAt: new Date('2026-09-29T10:01:00.000Z'),
              },
            ],
          },
        ],
      },
    ]);

    const result = await service.findPublishedPage({
      first: 10,
      filter: { upcomingOnly: true, city: 'Hanoi' },
    });

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          upcomingOnly: true,
          city: 'Hanoi',
        }),
        now,
      }),
    );
    expect(result.nodes[0]).toMatchObject({
      nextSession: { id: 'session-first' },
      priceFrom: 900,
      currency: 'VND',
      availability: null,
    });
  });

  it('leaves existing event pagination unrestricted unless upcomingOnly is true', async () => {
    findPublishedPage.mockResolvedValue([]);

    await service.findPublishedPage({ first: 10 });

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ upcomingOnly: false }),
      }),
    );
  });

  it('applies country and place together to event match and the VN next session', async () => {
    const hanoi = {
      id: 'hanoi',
      status: 'SCHEDULED',
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      startsAt: new Date('2026-10-02T10:00:00.000Z'),
      ticketTypes: [],
    };
    const hoChiMinh = {
      ...hanoi,
      id: 'ho-chi-minh',
      placeId: 'VN-HOCHIMINH',
      startsAt: new Date('2026-10-03T10:00:00.000Z'),
    };
    findPublishedPage.mockResolvedValue([
      { id: 'vn-event', sessions: [hanoi, hoChiMinh] },
    ]);

    const result = await service.findPublishedPage({
      filter: {
        categoryId: '64b64c0000000000000000e1',
        q: 'music',
        countryCode: 'vn',
        placeId: 'VN-HOCHIMINH',
        startsAtFrom: new Date('2026-10-01T00:00:00.000Z'),
        startsAtTo: new Date('2026-10-04T00:00:00.000Z'),
      },
      includeSummary: true,
    });

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          categoryId: '64b64c0000000000000000e1',
          q: 'music',
          countryCode: 'VN',
          placeId: 'VN-HOCHIMINH',
        }),
      }),
    );
    expect(result.nodes[0].nextSession.id).toBe('ho-chi-minh');
  });

  it('selects California rather than New York when both US sessions share a locality', async () => {
    const sameLocality = {
      id: 'california',
      status: 'SCHEDULED',
      countryCode: 'US',
      placeId: 'US-CA',
      city: 'New York',
      startsAt: new Date('2026-10-02T10:00:00.000Z'),
      ticketTypes: [],
    };
    findPublishedPage.mockResolvedValue([
      {
        id: 'us-event',
        sessions: [
          { ...sameLocality, id: 'new-york', placeId: 'US-NY' },
          sameLocality,
        ],
      },
    ]);

    const result = await service.findPublishedPage({
      filter: { countryCode: 'US', placeId: 'US-CA' },
    });

    expect(result.nodes[0].nextSession.id).toBe('california');
  });

  it('rejects unsupported countries and cross-country place IDs', async () => {
    await expect(
      service.findPublishedPage({ filter: { countryCode: 'CA' } }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      service.findPublishedPage({
        filter: { countryCode: 'VN', placeId: 'US-CA' },
      }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(findPublishedPage).not.toHaveBeenCalled();
  });

  it('treats explicit null location filters like omitted fields', async () => {
    findPublishedPage.mockResolvedValue([]);
    await service.findPublishedPage({
      filter: { countryCode: null, placeId: null },
    });

    expect(findPublishedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          countryCode: undefined,
          placeId: undefined,
        }),
      }),
    );
  });
});

describe('EventService.getTicketSnapshot', () => {
  let service: EventService;
  const findById = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: EventsRepository, useValue: { findById } },
        { provide: EventsSessionRepository, useValue: {} },
        { provide: OutboxProcessor, useValue: {} },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('returns only the requested event and session render snapshot', async () => {
    findById.mockResolvedValue({
      status: 'PUBLISHED',
      title: 'Saigon Live',
      coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/event.png',
      posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
      sessions: [
        {
          id: '64b64c0000000000000000e2',
          status: 'SCHEDULED',
          venueName: 'Phu Tho Stadium',
          venueAddress: 'Ho Chi Minh City',
          startsAt: new Date('2026-10-10T12:00:00.000Z'),
          endsAt: new Date('2026-10-10T15:00:00.000Z'),
          timezone: 'Asia/Ho_Chi_Minh',
          version: 4,
        },
      ],
    });

    await expect(
      service.getTicketSnapshot(
        '64b64c0000000000000000e1',
        '64b64c0000000000000000e2',
      ),
    ).resolves.toEqual({
      eventTitle: 'Saigon Live',
      eventStatus: 'PUBLISHED',
      coverImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/event.png',
      posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
      venueName: 'Phu Tho Stadium',
      venueAddress: 'Ho Chi Minh City',
      startsAt: new Date('2026-10-10T12:00:00.000Z'),
      endsAt: new Date('2026-10-10T15:00:00.000Z'),
      timezone: 'Asia/Ho_Chi_Minh',
      sessionVersion: 4,
      sessionStatus: 'SCHEDULED',
    });
  });

  it('rejects a session that does not belong to the requested event', async () => {
    findById.mockResolvedValue({ title: 'Saigon Live', sessions: [] });
    await expect(
      service.getTicketSnapshot(
        '64b64c0000000000000000e1',
        '64b64c0000000000000000e2',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
});

describe('EventService.findSessionsPage location filters', () => {
  let service: EventService;
  const findVisibilityById = vi.fn();
  const findPage = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    findVisibilityById.mockResolvedValue({ ownerId: 'u1', status: 'PUBLISHED' });
    findPage.mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        EventService,
        { provide: EventsRepository, useValue: { findVisibilityById } },
        { provide: EventsSessionRepository, useValue: { findPage } },
        { provide: OutboxProcessor, useValue: {} },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('filters by exact place and preserves manager visibility and cursor', async () => {
    const eventId = '64b64c0000000000000000e1';
    const afterId = '64b64c0000000000000000e2';
    await service.findSessionsPage(
      {
        eventId,
        after: Buffer.from(`session:${afterId}`).toString('base64url'),
        filter: { countryCode: 'us', placeId: 'US-CA' },
      },
    );

    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId,
        afterId,
        includeDrafts: false,
        filter: expect.objectContaining({ countryCode: 'US', placeId: 'US-CA' }),
      }),
    );
  });

  it('rejects mismatched place before querying sessions', async () => {
    await expect(
      service.findSessionsPage({
        eventId: '64b64c0000000000000000e1',
        filter: { countryCode: 'VN', placeId: 'US-CA' },
      }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(findPage).not.toHaveBeenCalled();
  });

  it('treats explicit null session location filters as omitted', async () => {
    await service.findSessionsPage({
      eventId: '64b64c0000000000000000e1',
      filter: { countryCode: null, placeId: null },
    });

    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          countryCode: undefined,
          placeId: undefined,
        }),
      }),
    );
  });
});

describe('EventService.requestBookingRefund', () => {
  let service: EventService;
  const findByIdAndOwner = vi.fn();
  const emitRefundRequest = vi.fn();
  const wake = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    emitRefundRequest.mockResolvedValue({});

    const module = await Test.createTestingModule({
      providers: [
        EventService,
        {
          provide: EventsRepository,
          useValue: { findByIdAndOwner, emitRefundRequest },
        },
        { provide: EventsSessionRepository, useValue: {} },
        { provide: OutboxProcessor, useValue: { wake } },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('emits booking.refund.requested when caller owns the event', async () => {
    findByIdAndOwner.mockResolvedValue({ id: 'e1', version: 3 });

    const result = await service.requestBookingRefund(
      { eventId: 'e1', bookingId: 'bk1', reason: 'show moved' },
      'u1',
    );

    expect(result).toBe(true);
    expect(emitRefundRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'e1',
        aggregateVersion: 3,
        bookingId: 'bk1',
        reason: 'show moved',
        requestedBy: 'u1',
      }),
    );
    expect(wake).toHaveBeenCalled();
  });

  it('rejects when caller does not own the event', async () => {
    findByIdAndOwner.mockResolvedValue(null);

    await expect(
      service.requestBookingRefund(
        { eventId: 'e1', bookingId: 'bk1' },
        'intruder',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(emitRefundRequest).not.toHaveBeenCalled();
  });
});

describe('EventService.updateStatus ARCHIVED guard', () => {
  let service: EventService;
  const findByIdAndOwner = vi.fn();
  const updateStatus = vi.fn();
  const countLiveSessions = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    updateStatus.mockResolvedValue({ ...published, status: 'ARCHIVED' });

    const module = await Test.createTestingModule({
      providers: [
        EventService,
        {
          provide: EventsRepository,
          useValue: { findByIdAndOwner, updateStatus },
        },
        {
          provide: EventsSessionRepository,
          useValue: { countLiveSessions },
        },
        { provide: OutboxProcessor, useValue: { wake: vi.fn() } },
      ],
    }).compile();
    service = module.get(EventService);
  });

  it('rejects archiving while live sessions remain', async () => {
    findByIdAndOwner.mockResolvedValue(published);
    countLiveSessions.mockResolvedValue(2);

    await expect(
      service.updateStatus({ id: 'e1', status: 'ARCHIVED' as never }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('archives when all sessions are terminal', async () => {
    findByIdAndOwner.mockResolvedValue(published);
    countLiveSessions.mockResolvedValue(0);

    await service.updateStatus({ id: 'e1', status: 'ARCHIVED' as never }, 'u1');
    expect(updateStatus).toHaveBeenCalled();
  });
});

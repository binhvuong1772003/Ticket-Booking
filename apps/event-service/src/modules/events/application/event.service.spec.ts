import { beforeEach, describe, expect, it, vi } from 'vitest';
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

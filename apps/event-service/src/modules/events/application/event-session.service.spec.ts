import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventSessionService } from './event-session.service';
import { EventsRepository } from '../infrastructure/events.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { TicketTypeRepository } from '../infrastructure/ticket-type.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

const draftSession = {
  id: 's1',
  eventId: 'e1',
  status: 'DRAFT',
  startsAt: new Date('2026-10-01T10:00:00Z'),
  endsAt: new Date('2026-10-01T12:00:00Z'),
  event: { status: 'PUBLISHED' },
};

const scheduledSession = { ...draftSession, status: 'SCHEDULED' };

describe('EventSessionService', () => {
  let service: EventSessionService;
  const findByIdAndOwner = vi.fn();
  const updateStatus = vi.fn();
  const reschedule = vi.fn();
  const update = vi.fn();
  const wake = vi.fn();
  const findByIdAndOwnerEvent = vi.fn();
  const create = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    updateStatus.mockResolvedValue(scheduledSession);
    reschedule.mockResolvedValue(scheduledSession);
    update.mockResolvedValue(draftSession);
    findByIdAndOwnerEvent.mockResolvedValue({ status: 'DRAFT' });
    create.mockResolvedValue({ id: 's1' });

    const module = await Test.createTestingModule({
      providers: [
        EventSessionService,
        {
          provide: EventsRepository,
          useValue: { findByIdAndOwner: findByIdAndOwnerEvent },
        },
        {
          provide: EventsSessionRepository,
          useValue: {
            findByIdAndOwner,
            updateStatus,
            reschedule,
            update,
            create,
          },
        },
        { provide: TicketTypeRepository, useValue: {} },
        { provide: OutboxProcessor, useValue: { wake } },
      ],
    }).compile();
    service = module.get(EventSessionService);
  });

  it('schedules a draft session when event is published', async () => {
    findByIdAndOwner.mockResolvedValue(draftSession);
    await service.updateStatus(
      { id: 's1', status: 'SCHEDULED' as never },
      'u1',
    );
    expect(updateStatus).toHaveBeenCalledWith(
      's1',
      'u1',
      'DRAFT',
      'SCHEDULED',
      undefined,
    );
    expect(wake).toHaveBeenCalled();
  });

  it('stores the canonical VN city when creating a catalog session', async () => {
    await service.create(
      {
        eventId: 'e1',
        countryCode: 'VN',
        placeId: 'VN-HOCHIMINH',
        city: 'Saigon',
      },
      'u1',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: 'VN',
        placeId: 'VN-HOCHIMINH',
        city: 'TP. Hồ Chí Minh',
      }),
    );
  });

  it.each(['NO-SUCH-PLACE', 'US-CA'])(
    'rejects wrong or cross-country place %s before create',
    async (placeId) => {
      await expect(
        service.create({ eventId: 'e1', countryCode: 'VN', placeId }, 'u1'),
      ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('keeps US city as organizer locality', async () => {
    await service.create(
      {
        eventId: 'e1',
        countryCode: 'US',
        placeId: 'US-CA',
        city: 'San Francisco',
      },
      'u1',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: 'US-CA', city: 'San Francisco' }),
    );
  });

  it('stores the submitted locality for VN-OTHER and requires a nonblank city', async () => {
    await service.create(
      {
        eventId: 'e1',
        countryCode: 'VN',
        placeId: 'VN-OTHER',
        city: '  Buon Ma Thuot  ',
      },
      'u1',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: 'VN-OTHER', city: '  Buon Ma Thuot  ' }),
    );

    await expect(
      service.create(
        { eventId: 'e1', countryCode: 'VN', placeId: 'VN-OTHER', city: '  ' },
        'u1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      service.create(
        { eventId: 'e1', countryCode: 'VN', placeId: 'VN-OTHER' },
        'u1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('allows US-OTHER without a locality', async () => {
    await service.create(
      {
        eventId: 'e1',
        countryCode: 'US',
        placeId: 'US-OTHER',
        city: null,
      },
      'u1',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: 'US-OTHER', city: null }),
    );
  });

  it.each([
    ['VN', 'US-OTHER'],
    ['US', 'VN-OTHER'],
  ])('rejects cross-country Other place %s/%s', async (countryCode, placeId) => {
    await expect(
      service.create({ eventId: 'e1', countryCode, placeId }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('requires replacing or clearing an existing place on country change', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.update({ id: 's1', countryCode: 'US' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('preserves the existing place when updating another draft field', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await service.update({ id: 's1', name: 'Updated' }, 'u1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Updated', placeId: undefined }),
    );
  });

  it('clears a draft place when update explicitly sends null', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await service.update({ id: 's1', placeId: null }, 'u1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: null }),
    );
  });

  it('updates a draft to a US state while retaining organizer locality', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await service.update(
      { id: 's1', countryCode: 'US', placeId: 'US-CA', city: 'Palo Alto' },
      'u1',
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: 'US',
        placeId: 'US-CA',
        city: 'Palo Alto',
      }),
    );
  });

  it('uses an existing city when switching a VN session to VN-OTHER', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      city: 'Hải Dương',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await service.update({ id: 's1', placeId: 'VN-OTHER' }, 'u1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: 'VN-OTHER', city: undefined }),
    );
  });

  it('rejects an empty effective VN-OTHER city on update and explicit clearing', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      city: null,
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.update({ id: 's1', placeId: 'VN-OTHER' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      city: 'Bac Ninh',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.update({ id: 's1', placeId: 'VN-OTHER', city: null }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      countryCode: 'VN',
      city: 'Bac Ninh',
      placeId: 'VN-OTHER',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.update({ id: 's1', city: '  ' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects scheduling while event is still draft', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...draftSession,
      event: { status: 'DRAFT' },
    });
    await expect(
      service.updateStatus({ id: 's1', status: 'SCHEDULED' as never }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('rejects going back from scheduled to draft', async () => {
    findByIdAndOwner.mockResolvedValue(scheduledSession);
    await expect(
      service.updateStatus({ id: 's1', status: 'DRAFT' as never }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('cancels a draft session', async () => {
    findByIdAndOwner.mockResolvedValue(draftSession);
    await service.updateStatus(
      {
        id: 's1',
        status: 'CANCELLED' as never,
        cancellationReason: 'scrapped',
      },
      'u1',
    );
    expect(updateStatus).toHaveBeenCalledWith(
      's1',
      'u1',
      'DRAFT',
      'CANCELLED',
      'scrapped',
    );
  });

  it('blocks full update on scheduled session', async () => {
    findByIdAndOwner.mockResolvedValue(scheduledSession);
    await expect(
      service.update({ id: 's1', name: 'new name' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('reschedules time on a scheduled session', async () => {
    findByIdAndOwner.mockResolvedValue(scheduledSession);
    const startsAt = new Date('2026-10-02T10:00:00Z');
    const endsAt = new Date('2026-10-02T12:00:00Z');
    await service.reschedule({ id: 's1', startsAt, endsAt }, 'u1');
    expect(reschedule).toHaveBeenCalledWith(
      's1',
      'u1',
      expect.objectContaining({ startsAt, endsAt }),
    );
    expect(wake).toHaveBeenCalled();
  });

  it('rejects clearing a scheduled place', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'US',
      placeId: 'US-CA',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.reschedule({ id: 's1', placeId: null }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('requires a replacement place when rescheduling across countries', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'VN',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.reschedule({ id: 's1', countryCode: 'US' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('reschedules with a canonical VN city', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'VN',
      event: { status: 'PUBLISHED' },
    });
    await service.reschedule(
      { id: 's1', placeId: 'VN-DANANG', city: 'Da Nang' },
      'u1',
    );
    expect(reschedule).toHaveBeenCalledWith(
      's1',
      'u1',
      expect.objectContaining({ placeId: 'VN-DANANG', city: 'Đà Nẵng' }),
    );
  });

  it('requires and preserves VN-OTHER city on reschedule', async () => {
    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'VN',
      city: 'Hải Dương',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await service.reschedule({ id: 's1', placeId: 'VN-OTHER' }, 'u1');
    expect(reschedule).toHaveBeenCalledWith(
      's1',
      'u1',
      expect.objectContaining({ placeId: 'VN-OTHER', city: undefined }),
    );

    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'VN',
      city: 'Hải Dương',
      placeId: 'VN-HANOI',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.reschedule({ id: 's1', placeId: 'VN-OTHER', city: '  ' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });

    findByIdAndOwner.mockResolvedValue({
      ...scheduledSession,
      countryCode: 'VN',
      city: 'Hải Dương',
      placeId: 'VN-OTHER',
      event: { status: 'PUBLISHED' },
    });
    await expect(
      service.reschedule({ id: 's1', city: null }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects reschedule on a draft session', async () => {
    findByIdAndOwner.mockResolvedValue(draftSession);
    await expect(
      service.reschedule({ id: 's1', venueName: 'New venue' }, 'u1'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(reschedule).not.toHaveBeenCalled();
  });

  it('rejects reschedule with endsAt before startsAt', async () => {
    findByIdAndOwner.mockResolvedValue(scheduledSession);
    await expect(
      service.reschedule(
        {
          id: 's1',
          startsAt: new Date('2026-10-02T12:00:00Z'),
          endsAt: new Date('2026-10-02T10:00:00Z'),
        },
        'u1',
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(reschedule).not.toHaveBeenCalled();
  });
});

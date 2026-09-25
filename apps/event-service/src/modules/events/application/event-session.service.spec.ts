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

  beforeEach(async () => {
    vi.clearAllMocks();
    updateStatus.mockResolvedValue(scheduledSession);
    reschedule.mockResolvedValue(scheduledSession);
    update.mockResolvedValue(draftSession);

    const module = await Test.createTestingModule({
      providers: [
        EventSessionService,
        { provide: EventsRepository, useValue: {} },
        {
          provide: EventsSessionRepository,
          useValue: { findByIdAndOwner, updateStatus, reschedule, update },
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

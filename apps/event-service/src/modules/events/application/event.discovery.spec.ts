import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventService } from './event.service';
import { EventsRepository } from '../infrastructure/events.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

describe('EventService featured event discovery', () => {
  const findFeaturedEvents = vi.fn();
  const setFeaturedOrder = vi.fn();
  let service: EventService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EventService(
      { findFeaturedEvents, setFeaturedOrder } as unknown as EventsRepository,
      {} as EventsSessionRepository,
      {} as OutboxProcessor,
    );
  });

  it('rejects featured limits outside 1 to 20 and invalid city filters', async () => {
    await expect(service.findFeaturedEvents({ first: 0 })).rejects.toMatchObject(
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
    await expect(service.findFeaturedEvents({ first: 21 })).rejects.toMatchObject(
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
    await expect(
      service.findFeaturedEvents({ city: 'x'.repeat(101) }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(findFeaturedEvents).not.toHaveBeenCalled();
  });

  it('uses the featured order and returns the same card summary as eventsPage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'));
    findFeaturedEvents.mockResolvedValue([
      {
        id: 'event-1',
        sessions: [
          {
            id: 'session-1',
            status: 'SCHEDULED',
            startsAt: new Date('2026-10-01T10:00:00.000Z'),
            city: 'Hanoi',
            currency: 'VND',
            ticketTypes: [
              { status: 'ACTIVE', price: 250000, salesStartAt: null },
              { status: 'INACTIVE', price: 1, salesStartAt: null },
            ],
          },
        ],
      },
    ]);

    try {
      const result = await service.findFeaturedEvents({
        first: 3,
        city: 'Hanoi',
      });

      expect(findFeaturedEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          first: 3,
          now: new Date('2026-09-29T10:00:00.000Z'),
          city: 'Hanoi',
        }),
      );
      expect(result[0]).toMatchObject({
        nextSession: { id: 'session-1' },
        priceFrom: 250000,
        currency: 'VND',
        availability: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an empty list when no event is featured', async () => {
    findFeaturedEvents.mockResolvedValue([]);

    await expect(service.findFeaturedEvents({})).resolves.toEqual([]);
  });

  it('allows zero order to feature and null order to remove an event', async () => {
    setFeaturedOrder.mockResolvedValue({ id: '64b64c0000000000000000e1' });

    await service.setEventFeatured('64b64c0000000000000000e1', 0);
    await service.setEventFeatured('64b64c0000000000000000e1', null);

    expect(setFeaturedOrder).toHaveBeenNthCalledWith(
      1,
      '64b64c0000000000000000e1',
      0,
    );
    expect(setFeaturedOrder).toHaveBeenNthCalledWith(
      2,
      '64b64c0000000000000000e1',
      null,
    );
  });

  it('rejects negative or fractional featured order and malformed event IDs', async () => {
    expect(() => service.setEventFeatured('64b64c0000000000000000e1', -1)).toThrow(
      'featuredOrder must be a non-negative integer or null',
    );
    expect(() => service.setEventFeatured('64b64c0000000000000000e1', 1.5)).toThrow(
      'featuredOrder must be a non-negative integer or null',
    );
    expect(() => service.setEventFeatured('bad-id', 1)).toThrow('Event not found');
    expect(setFeaturedOrder).not.toHaveBeenCalled();
  });
});

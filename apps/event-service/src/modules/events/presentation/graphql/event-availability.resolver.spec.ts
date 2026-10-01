import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventAvailabilityResolver } from './event-availability.resolver';
import { EventAvailability } from './models/event.model';
import { InventoryAvailabilityClient } from '../../infrastructure/inventory-availability.client';

describe('EventAvailabilityResolver', () => {
  const getAvailability = vi.fn();
  let resolver: EventAvailabilityResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    resolver = new EventAvailabilityResolver({
      getAvailability,
    } as unknown as InventoryAvailabilityClient);
  });

  const context = () => ({ req: {} });
  const upcomingEvent = (ticketTypes: object[]) => ({
    id: 'event-1',
    status: 'PUBLISHED',
    sessions: [],
    nextSession: {
      id: 'session-1',
      status: 'SCHEDULED',
      startsAt: new Date(Date.now() + 60_000),
      ticketTypes,
    },
  });

  it('returns AVAILABLE when at least one active type has inventory', async () => {
    getAvailability.mockResolvedValue([
      { key: 'sold-out:session-1', availableQuantity: 0 },
      { key: 'ticket-1:session-1', availableQuantity: 2 },
    ]);
    const ctx = context();

    await expect(
      resolver.availability(
        upcomingEvent([
          { id: 'sold-out', sessionId: 'session-1', status: 'ACTIVE', salesStartAt: null },
          { id: 'ticket-1', sessionId: 'session-1', status: 'ACTIVE', salesStartAt: null },
        ]) as never,
        ctx,
      ),
    ).resolves.toBe(EventAvailability.AVAILABLE);
    expect(getAvailability).toHaveBeenCalledWith([
      { ticketTypeId: 'sold-out', sessionId: 'session-1' },
      { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
    ]);
  });

  it('distinguishes not-yet-on-sale, sold out, ended, and cancelled events', async () => {
    getAvailability.mockResolvedValue([
      { key: 'ticket-1:session-1', availableQuantity: 0 },
    ]);
    const futureTicket = upcomingEvent([
      { id: 'ticket-1', sessionId: 'session-1', status: 'ACTIVE', salesStartAt: new Date(Date.now() + 60_000) },
    ]);
    await expect(
      resolver.availability(futureTicket as never, context()),
    ).resolves.toBe(EventAvailability.NOT_ON_SALE);

    const soldOutTicket = upcomingEvent([
      { id: 'ticket-1', sessionId: 'session-1', status: 'ACTIVE', salesStartAt: null },
    ]);
    await expect(
      resolver.availability(soldOutTicket as never, context()),
    ).resolves.toBe(EventAvailability.SOLD_OUT);

    await expect(
      resolver.availability(
        { id: 'event-2', status: 'PUBLISHED', sessions: [] } as never,
        context(),
      ),
    ).resolves.toBe(EventAvailability.NOT_ON_SALE);
    await expect(
      resolver.availability(
        {
          id: 'event-ended',
          status: 'PUBLISHED',
          sessions: [{ id: 'past', status: 'COMPLETED', startsAt: new Date(Date.now() - 60_000) }],
        } as never,
        context(),
      ),
    ).resolves.toBe(EventAvailability.ENDED);
    await expect(
      resolver.availability(
        { id: 'event-3', status: 'CANCELLED', sessions: [] } as never,
        context(),
      ),
    ).resolves.toBe(EventAvailability.CANCELLED);
  });
});

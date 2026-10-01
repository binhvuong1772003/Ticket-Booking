import { describe, expect, it, vi } from 'vitest';
import { TicketAvailabilityLoader } from './ticket-availability.loader';

describe('TicketAvailabilityLoader', () => {
  it('batches concurrent ticket type reads into one inventory request', async () => {
    const getAvailability = vi.fn().mockResolvedValue([
      { key: 'ticket-1:session-1', availableQuantity: 4 },
      { key: 'ticket-2:session-1', availableQuantity: 0 },
    ]);
    const loader = new TicketAvailabilityLoader({ getAvailability } as never);

    const [first, second, duplicate] = await Promise.all([
      loader.load('ticket-1', 'session-1'),
      loader.load('ticket-2', 'session-1'),
      loader.load('ticket-1', 'session-1'),
    ]);

    expect(getAvailability).toHaveBeenCalledOnce();
    expect(getAvailability).toHaveBeenCalledWith([
      { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
      { ticketTypeId: 'ticket-2', sessionId: 'session-1' },
    ]);
    expect([first, second, duplicate]).toEqual([4, 0, 4]);
  });

  it('returns field-level retry errors for missing inventory and dependency failure', async () => {
    const missing = new TicketAvailabilityLoader({
      getAvailability: vi.fn().mockResolvedValue([]),
    } as never);
    await expect(missing.load('ticket-1', 'session-1')).rejects.toMatchObject({
      extensions: { code: 'INVENTORY_NOT_READY' },
    });

    const failed = new TicketAvailabilityLoader({
      getAvailability: vi.fn().mockRejectedValue(new Error('timeout')),
    } as never);
    await expect(failed.load('ticket-1', 'session-1')).rejects.toMatchObject({
      extensions: { code: 'INVENTORY_UNAVAILABLE' },
    });
  });
});

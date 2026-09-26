import { describe, expect, it, vi } from 'vitest';
import {
  TicketTypeUpdatedHandler,
  TicketTypeUpdatedEvent,
} from './ticket-type-updated.handler';
import { InventoryService } from '../inventory.service';
const snapshot = {
  sessionId: 's1',
  name: 'VIP',
  code: 'VIP',
  price: 100,
  currency: 'USD',
  quantity: 10,
  status: 'ACTIVE',
};
function event(fields: object): TicketTypeUpdatedEvent {
  return {
    eventId: 'e1',
    eventType: 'ticket-type.updated',
    occurredAt: '2026-09-01T00:00:00Z',
    payload: { ticketTypeId: 'tt1', ...fields },
  } as TicketTypeUpdatedEvent;
}
describe('schedule update consumer', () => {
  it.each(['2026-10-02T07:00:00+07:00', null])(
    'parses the schedule update %s',
    async (salesStartAt) => {
      const applyTicketTypeUpdated = vi.fn();
      const handler = new TicketTypeUpdatedHandler({
        applyTicketTypeUpdated,
      } as unknown as InventoryService);
      await handler.handle(
        event({
          salesStartAt,
          salesScheduleVersion: 1,
          inventorySnapshot: snapshot,
        }),
      );
      expect(applyTicketTypeUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          salesStartAt:
            salesStartAt === null ? null : new Date('2026-10-02T00:00:00Z'),
          salesScheduleVersion: 1,
        }),
      );
    },
  );
  it.each([
    { salesStartAt: 'bad', salesScheduleVersion: 1 },
    { salesStartAt: null },
    { salesStartAt: null, salesScheduleVersion: 0 },
    { salesStartAt: null, salesScheduleVersion: 1.5 },
  ])('rejects unsafe schedule update %j', async (fields) => {
    const applyTicketTypeUpdated = vi.fn();
    const handler = new TicketTypeUpdatedHandler({
      applyTicketTypeUpdated,
    } as unknown as InventoryService);
    await expect(
      Promise.resolve().then(() =>
        handler.handle(event({ ...fields, inventorySnapshot: snapshot })),
      ),
    ).rejects.toThrow();
    expect(applyTicketTypeUpdated).not.toHaveBeenCalled();
  });
  it('does not turn an omitted schedule into a reset', async () => {
    const applyTicketTypeUpdated = vi.fn();
    const handler = new TicketTypeUpdatedHandler({
      applyTicketTypeUpdated,
    } as unknown as InventoryService);
    await handler.handle(event({ name: 'Renamed' }));
    expect(
      applyTicketTypeUpdated.mock.calls[0][0].salesStartAt,
    ).toBeUndefined();
  });
});

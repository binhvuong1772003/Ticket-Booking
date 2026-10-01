import { describe, expect, it, vi } from 'vitest';
import { InventoryService } from '../../application/inventory.service';
import { InventoryController } from './inventory.controller';

describe('InventoryController.reserve', () => {
  it('returns the validated ticket, session, and event IDs', async () => {
    const reserve = vi.fn().mockResolvedValue({
      hold: { id: 'reservation-1' },
      inventory: {
        name: 'VIP',
        code: 'VIP',
        price: 2500,
        currency: 'USD',
      },
      ticketTypeId: 'ticket-type-1',
      sessionId: 'session-1',
      eventId: 'event-1',
    });
    const controller = new InventoryController({
      reserve,
    } as unknown as InventoryService);

    await expect(
      controller.reserve({
        event_id: 'event-1',
        session_id: 'session-1',
        ticket_type_id: 'ticket-type-1',
        quantity: 2,
        booking_id: 'booking-1',
        user_id: 'user-1',
      }),
    ).resolves.toMatchObject({
      success: true,
      reservation_id: 'reservation-1',
      ticket_type_id: 'ticket-type-1',
      session_id: 'session-1',
      event_id: 'event-1',
      ticket_type_name: 'VIP',
      unit_price: 2500,
    });
    expect(reserve).toHaveBeenCalledWith({
      ticketTypeId: 'ticket-type-1',
      sessionId: 'session-1',
      eventId: 'event-1',
      quantity: 2,
      bookingId: 'booking-1',
      userId: 'user-1',
    });
  });
});

describe('InventoryController.getAvailability', () => {
  it('maps the batch inventory response to the gRPC contract', async () => {
    const getAvailability = vi.fn().mockResolvedValue([
      { ticketTypeId: 'ticket-1', sessionId: 'session-1', availableQuantity: 3 },
    ]);
    const controller = new InventoryController({
      getAvailability,
    } as unknown as InventoryService);

    await expect(
      controller.getAvailability({
        ticket_types: [{ ticket_type_id: 'ticket-1', session_id: 'session-1' }],
      }),
    ).resolves.toEqual({
      items: [{ ticket_type_id: 'ticket-1', available_quantity: 3, session_id: 'session-1' }],
    });
    expect(getAvailability).toHaveBeenCalledWith([
      { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
    ]);
  });
});

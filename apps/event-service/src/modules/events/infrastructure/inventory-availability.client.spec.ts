import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { ClientGrpc } from '@nestjs/microservices';
import { InventoryAvailabilityClient } from './inventory-availability.client';

describe('InventoryAvailabilityClient', () => {
  it('sends ticket/session pairs in one internal batch and maps the response', async () => {
    const getAvailability = vi.fn().mockReturnValue(
      of({
        items: [
          {
            ticket_type_id: 'ticket-1',
            session_id: 'session-1',
            available_quantity: 3,
          },
        ],
      }),
    );
    const grpcClient = {
      getService: vi.fn().mockReturnValue({ getAvailability }),
    };
    const client = new InventoryAvailabilityClient(grpcClient as unknown as ClientGrpc);
    client.onModuleInit();

    await expect(
      client.getAvailability([
        { ticketTypeId: 'ticket-1', sessionId: 'session-1' },
      ]),
    ).resolves.toEqual([
      { key: 'ticket-1:session-1', availableQuantity: 3 },
    ]);
    expect(getAvailability).toHaveBeenCalledWith({
      ticket_types: [
        { ticket_type_id: 'ticket-1', session_id: 'session-1' },
      ],
    });
  });
});

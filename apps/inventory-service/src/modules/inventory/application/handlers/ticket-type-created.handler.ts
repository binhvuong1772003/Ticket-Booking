import { Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory.service';

export type TicketTypeCreatedEvent = {
  eventId: string;
  eventType: 'ticket-type.created';
  occurredAt: string;
  payload: {
    ticketTypeId: string;
    sessionId: string;
    quantity: number;
  };
};

@Injectable()
export class TicketTypeCreatedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: TicketTypeCreatedEvent) {
    return this.inventoryService.createFromTicketTypeCreated({
      ticketTypeId: event.payload.ticketTypeId,
      total: event.payload.quantity,
    });
  }
}

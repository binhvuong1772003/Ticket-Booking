import { Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory.service';

export type TicketTypeCreatedEvent = {
  eventId: string;
  eventType: 'ticket-type.created';
  occurredAt: string;
  payload: {
    ticketTypeId: string;
    sessionId: string;
    name: string;
    code: string;
    price: number;
    currency: string;
    quantity: number;
  };
};

@Injectable()
export class TicketTypeCreatedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: TicketTypeCreatedEvent) {
    return this.inventoryService.createFromTicketTypeCreated({
      ticketTypeId: event.payload.ticketTypeId,
      name: event.payload.name,
      code: event.payload.code,
      price: event.payload.price,
      currency: event.payload.currency,
      total: event.payload.quantity,
    });
  }
}

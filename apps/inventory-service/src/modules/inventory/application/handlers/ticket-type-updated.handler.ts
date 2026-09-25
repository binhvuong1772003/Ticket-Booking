import { Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory.service';

export type TicketTypeUpdatedEvent = {
  eventId: string;
  eventType: 'ticket-type.updated';
  occurredAt: string;
  payload: {
    ticketTypeId: string;
    sessionId?: string;
    name?: string;
    code?: string;
    price?: number;
    currency?: string;
    quantity?: number;
    status?: string;
  };
};

@Injectable()
export class TicketTypeUpdatedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: TicketTypeUpdatedEvent) {
    return this.inventoryService.applyTicketTypeUpdated(event.payload);
  }
}

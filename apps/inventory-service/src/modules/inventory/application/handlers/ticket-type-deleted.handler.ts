import { Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory.service';

export type TicketTypeDeletedEvent = {
  eventId: string;
  eventType: 'ticket-type.deleted';
  occurredAt: string;
  payload: {
    ticketTypeId: string;
    sessionId?: string;
  };
};

@Injectable()
export class TicketTypeDeletedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: TicketTypeDeletedEvent) {
    return this.inventoryService.applyTicketTypeDeleted(
      event.payload.ticketTypeId,
    );
  }
}

import { Injectable } from '@nestjs/common';
import { parseSalesStartAt, parseSalesScheduleVersion } from './sales-start-at';
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
    salesStartAt?: string | null;
    salesScheduleVersion?: number;
    inventorySnapshot?: {
      sessionId: string;
      name: string;
      code: string;
      price: number;
      currency: string;
      quantity: number;
      status: string;
    };
  };
};

@Injectable()
export class TicketTypeUpdatedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: TicketTypeUpdatedEvent) {
    const payload = event.payload;
    const schedule = payload.salesStartAt !== undefined;
    if (schedule && !payload.inventorySnapshot)
      throw new Error('Missing inventorySnapshot for schedule update');
    return this.inventoryService.applyTicketTypeUpdated({
      ...payload,
      salesStartAt: schedule
        ? parseSalesStartAt(payload.salesStartAt)
        : undefined,
      salesScheduleVersion: schedule
        ? parseSalesScheduleVersion(payload.salesScheduleVersion, 1)
        : undefined,
    });
  }
}

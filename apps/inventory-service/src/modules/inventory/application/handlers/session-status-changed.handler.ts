import { Injectable } from '@nestjs/common';
import { InventoryService } from '../inventory.service';

export type SessionStatusChangedEvent = {
  eventId: string;
  eventType: 'session.status.changed';
  occurredAt: string;
  payload: {
    sessionId: string;
    eventId?: string;
    status: string;
  };
};

@Injectable()
export class SessionStatusChangedHandler {
  constructor(private readonly inventoryService: InventoryService) {}

  handle(event: SessionStatusChangedEvent) {
    return this.inventoryService.applySessionStatusChanged({
      sessionId: event.payload.sessionId,
      status: event.payload.status,
    });
  }
}

import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  TicketTypeCreatedEvent,
  TicketTypeCreatedHandler,
} from '../../application/handlers/ticket-type-created.handler';
import {
  TicketTypeUpdatedEvent,
  TicketTypeUpdatedHandler,
} from '../../application/handlers/ticket-type-updated.handler';
import {
  TicketTypeDeletedEvent,
  TicketTypeDeletedHandler,
} from '../../application/handlers/ticket-type-deleted.handler';
import {
  SessionStatusChangedEvent,
  SessionStatusChangedHandler,
} from '../../application/handlers/session-status-changed.handler';

@Controller()
export class InventoryConsumer {
  constructor(
    private readonly ticketTypeCreatedHandler: TicketTypeCreatedHandler,
    private readonly ticketTypeUpdatedHandler: TicketTypeUpdatedHandler,
    private readonly ticketTypeDeletedHandler: TicketTypeDeletedHandler,
    private readonly sessionStatusChangedHandler: SessionStatusChangedHandler,
  ) {}

  @EventPattern('ticket-type.created')
  handleTicketTypeCreated(@Payload() event: TicketTypeCreatedEvent) {
    return this.ticketTypeCreatedHandler.handle(event);
  }

  @EventPattern('ticket-type.updated')
  handleTicketTypeUpdated(@Payload() event: TicketTypeUpdatedEvent) {
    return this.ticketTypeUpdatedHandler.handle(event);
  }

  @EventPattern('ticket-type.deleted')
  handleTicketTypeDeleted(@Payload() event: TicketTypeDeletedEvent) {
    return this.ticketTypeDeletedHandler.handle(event);
  }

  @EventPattern('session.status.changed')
  handleSessionStatusChanged(@Payload() event: SessionStatusChangedEvent) {
    return this.sessionStatusChangedHandler.handle(event);
  }
}

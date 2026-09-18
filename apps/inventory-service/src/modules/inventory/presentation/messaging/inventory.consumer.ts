import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import {
  TicketTypeCreatedEvent,
  TicketTypeCreatedHandler,
} from '../../application/handlers/ticket-type-created.handler';

@Controller()
export class InventoryConsumer {
  constructor(
    private readonly ticketTypeCreatedHandler: TicketTypeCreatedHandler,
  ) {}

  @EventPattern('ticket-type.created')
  handleTicketTypeCreated(@Payload() event: TicketTypeCreatedEvent) {
    return this.ticketTypeCreatedHandler.handle(event);
  }
}

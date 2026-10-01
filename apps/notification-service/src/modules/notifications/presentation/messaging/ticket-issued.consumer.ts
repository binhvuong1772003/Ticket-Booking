import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { TicketIssuedEvent } from '../../../../../../../libs/contracts/src/events/ticket/ticket-issued.event';
import { TicketIssuedEmailHandler } from '../../application/handlers/ticket-issued.handler.js';

@Controller()
export class TicketIssuedConsumer {
  constructor(
    private readonly ticketIssuedEmailHandler: TicketIssuedEmailHandler,
  ) {}

  @EventPattern('ticket.issued')
  handleTicketIssued(@Payload() event: TicketIssuedEvent) {
    return this.ticketIssuedEmailHandler.handleTicketIssued(event);
  }
}

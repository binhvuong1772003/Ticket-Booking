import { Injectable } from '@nestjs/common';
import { EventSessionStatus, EventStatus } from '@prisma/client';
import { CreateTicketTypeInput } from '../presentation/graphql/inputs/create-ticket-type.input';
import {
  CreateTicketTypeData,
  TicketTypeRepository,
} from '../infrastructure/ticket-type.repository';
import { EventsSessionRepository } from '../infrastructure/event-session.repository';
import { ApiError } from '../../../common/errors/api-error';
import { OutboxProcessor } from '../infrastructure/outbox.processor';

@Injectable()
export class TicketTypeService {
  constructor(
    private readonly eventsSessionRepository: EventsSessionRepository,
    private readonly ticketTypeRepository: TicketTypeRepository,
    private readonly outboxProcessor: OutboxProcessor,
  ) {}

  async create(input: CreateTicketTypeInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const session = await this.eventsSessionRepository.findByIdAndOwner(
      input.sessionId,
      ownerId,
    );

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    if (
      session.event.status === EventStatus.CANCELLED ||
      session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot add ticket types to a closed event',
        'BAD_USER_INPUT',
      );
    }

    if (session.status !== EventSessionStatus.SCHEDULED) {
      throw new ApiError(
        'Ticket types can only be added to scheduled sessions',
        'BAD_USER_INPUT',
      );
    }

    if (session.capacity !== null) {
      const allocatedQuantity =
        await this.ticketTypeRepository.getTotalQuantity(input.sessionId);

      if (allocatedQuantity + input.quantity > session.capacity) {
        throw new ApiError(
          'Ticket quantity exceeds session capacity',
          'BAD_USER_INPUT',
          {
            capacity: session.capacity,
            allocatedQuantity,
            requestedQuantity: input.quantity,
          },
        );
      }
    }

    const data: CreateTicketTypeData = {
      sessionId: input.sessionId,
      name: input.name,
      code: input.code,
      price: input.price,
      currency: input.currency ?? 'USD',
      quantity: input.quantity,
    };

    const ticketType = await this.ticketTypeRepository.createWithOutbox(data);

    this.outboxProcessor.wake();

    return ticketType;
  }
}

import { Injectable } from '@nestjs/common';
import {
  EventSessionStatus,
  EventStatus,
  TicketTypeStatus,
} from '@prisma/client';
import { CreateTicketTypeInput } from '../presentation/graphql/inputs/create-ticket-type.input';
import { UpdateTicketTypeInput } from '../presentation/graphql/inputs/update-ticket-type.input';
import { UpdateTicketTypeStatusInput } from '../presentation/graphql/inputs/update-ticket-type-status.input';
import {
  CreateTicketTypeData,
  TicketTypeRepository,
  UpdateTicketTypeData,
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

    // Ticket-type chỉ được soạn khi session còn DRAFT — sau khi SCHEDULED
    // (đã công bố) toàn bộ danh mục vé bị khóa.
    if (session.status !== EventSessionStatus.DRAFT) {
      throw new ApiError(
        'Ticket types can only be added to draft sessions',
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
      sessionStatus: session.status,
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

  /* Sửa nội dung vé — chỉ khi session còn DRAFT. Lúc đó bán chưa mở nên
     không cần check sold/reserved; quantity tự do trong trần capacity. */
  async update(input: UpdateTicketTypeInput, ownerId: string) {
    const ticketType = await this.findOwnedEditable(input.id, ownerId);

    const data: UpdateTicketTypeData = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.code !== undefined) data.code = input.code;
    if (input.price !== undefined) data.price = input.price;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.quantity !== undefined) data.quantity = input.quantity;

    if (Object.keys(data).length === 0) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }

    if (data.quantity !== undefined) {
      const capacity = ticketType.session.capacity;
      if (capacity !== null) {
        const allocatedQuantity =
          await this.ticketTypeRepository.getTotalQuantity(
            ticketType.sessionId,
          );
        const projected =
          allocatedQuantity - ticketType.quantity + data.quantity;

        if (projected > capacity) {
          throw new ApiError(
            'Ticket quantity exceeds session capacity',
            'BAD_USER_INPUT',
            {
              capacity,
              allocatedQuantity,
              requestedQuantity: data.quantity,
            },
          );
        }
      }
    }

    const updated = await this.ticketTypeRepository.updateWithOutbox(
      input.id,
      data,
    );

    this.outboxProcessor.wake();

    return updated;
  }

  /* Bật/tắt bán — operation duy nhất của ticket-type còn mở sau khi
     session SCHEDULED (INACTIVE = van ngừng bán, không sửa dữ liệu đã bán).
     SOLD_OUT là trạng thái derive từ tồn kho, không cho set tay. */
  async updateStatus(input: UpdateTicketTypeStatusInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    if (input.status === TicketTypeStatus.SOLD_OUT) {
      throw new ApiError('SOLD_OUT cannot be set manually', 'BAD_USER_INPUT');
    }

    const ticketType = await this.ticketTypeRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!ticketType) {
      throw new ApiError('Ticket type not found', 'NOT_FOUND');
    }

    if (
      ticketType.session.event.status === EventStatus.CANCELLED ||
      ticketType.session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot modify a ticket type of a closed event',
        'BAD_USER_INPUT',
      );
    }

    if (
      ticketType.session.status !== EventSessionStatus.DRAFT &&
      ticketType.session.status !== EventSessionStatus.SCHEDULED
    ) {
      throw new ApiError(
        'Cannot change ticket type status of a closed session',
        'BAD_USER_INPUT',
      );
    }

    if (ticketType.status === input.status) {
      return ticketType;
    }

    const updated = await this.ticketTypeRepository.updateWithOutbox(input.id, {
      status: input.status,
    });

    this.outboxProcessor.wake();

    return updated;
  }

  // Xóa hẳn — chỉ khi session DRAFT nên chắc chắn chưa có giao dịch nào.
  async remove(id: string, ownerId: string) {
    await this.findOwnedEditable(id, ownerId);

    const deleted = await this.ticketTypeRepository.deleteWithOutbox(id);

    this.outboxProcessor.wake();

    return deleted;
  }

  private async findOwnedEditable(id: string, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const ticketType = await this.ticketTypeRepository.findByIdAndOwner(
      id,
      ownerId,
    );

    if (!ticketType) {
      throw new ApiError('Ticket type not found', 'NOT_FOUND');
    }

    if (
      ticketType.session.event.status === EventStatus.CANCELLED ||
      ticketType.session.event.status === EventStatus.ARCHIVED
    ) {
      throw new ApiError(
        'Cannot modify a ticket type of a closed event',
        'BAD_USER_INPUT',
      );
    }

    if (ticketType.session.status !== EventSessionStatus.DRAFT) {
      throw new ApiError(
        'Ticket types can only be modified while the session is a draft',
        'BAD_USER_INPUT',
      );
    }

    return ticketType;
  }
}

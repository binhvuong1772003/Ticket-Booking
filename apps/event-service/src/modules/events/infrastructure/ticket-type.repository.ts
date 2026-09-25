import { Injectable } from '@nestjs/common';
import { Prisma, TicketTypeStatus } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateTicketTypeData = {
  sessionId: string;
  sessionStatus: string;
  name: string;
  code: string;
  price: number;
  currency: string;
  quantity: number;
};

// Chỉ field nào đổi mới có mặt trong payload ticket-type.updated.
export type UpdateTicketTypeData = {
  name?: string;
  code?: string;
  price?: number;
  currency?: string;
  quantity?: number;
  status?: TicketTypeStatus;
};

@Injectable()
export class TicketTypeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithOutbox(data: CreateTicketTypeData) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ticketType = await tx.ticketType.create({
          data: {
            sessionId: data.sessionId,
            name: data.name,
            code: data.code,
            price: data.price,
            currency: data.currency,
            quantity: data.quantity,
          },
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: ticketType.id,
            eventType: 'ticket-type.created',
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: {
              ticketTypeId: ticketType.id,
              sessionId: ticketType.sessionId,
              sessionStatus: data.sessionStatus,
              name: ticketType.name,
              code: ticketType.code,
              price: ticketType.price,
              currency: ticketType.currency,
              quantity: ticketType.quantity,
            },
          },
        });

        return ticketType;
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError(
          'Ticket type code already exists for this session',
          'CONFLICT',
          { field: 'code' },
        );
      }

      throw new ApiError(
        'Failed to create ticket type',
        'INTERNAL_SERVER_ERROR',
      );
    }
  }

  async getTotalQuantity(sessionId: string) {
    const result = await this.prisma.ticketType.aggregate({
      where: { sessionId },
      _sum: { quantity: true },
    });

    return result._sum.quantity ?? 0;
  }

  // Ownership qua session → event.ownerId; kèm session.status/capacity và
  // event.status để service guard mà không query thêm.
  findByIdAndOwner(id: string, ownerId: string) {
    return this.prisma.ticketType.findFirst({
      where: {
        id,
        session: { event: { ownerId } },
      },
      include: {
        session: {
          select: {
            status: true,
            capacity: true,
            event: { select: { status: true } },
          },
        },
      },
    });
  }

  async updateWithOutbox(id: string, data: UpdateTicketTypeData) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ticketType = await tx.ticketType.update({
          where: { id },
          data,
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId: ticketType.id,
            eventType: 'ticket-type.updated',
            aggregateVersion: 1,
            schemaVersion: 1,
            payload: {
              ticketTypeId: ticketType.id,
              sessionId: ticketType.sessionId,
              ...data,
            },
          },
        });

        return ticketType;
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError(
          'Ticket type code already exists for this session',
          'CONFLICT',
          { field: 'code' },
        );
      }

      throw error;
    }
  }

  async deleteWithOutbox(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const ticketType = await tx.ticketType.delete({
        where: { id },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateId: ticketType.id,
          eventType: 'ticket-type.deleted',
          aggregateVersion: 1,
          schemaVersion: 1,
          payload: {
            ticketTypeId: ticketType.id,
            sessionId: ticketType.sessionId,
          },
        },
      });

      return ticketType;
    });
  }
}

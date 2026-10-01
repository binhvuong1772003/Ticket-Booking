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
  // Currency của session — chỉ đưa vào payload event, ticket_type không lưu.
  currency: string;
  quantity: number;
  salesStartAt?: Date | null;
};

// Chỉ field nào đổi mới có mặt trong payload ticket-type.updated.
// Currency sống ở session — đổi qua updateEventSession, không qua đây.
export type UpdateTicketTypeData = {
  name?: string;
  code?: string;
  price?: number;
  quantity?: number;
  status?: TicketTypeStatus;
  salesStartAt?: Date | null;
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
            quantity: data.quantity,
            salesStartAt: data.salesStartAt ?? null,
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
              currency: data.currency,
              quantity: ticketType.quantity,
              salesStartAt: ticketType.salesStartAt?.toISOString() ?? null,
              salesScheduleVersion: ticketType.salesScheduleVersion ?? 0,
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
        const scheduleChanged = data.salesStartAt !== undefined;
        // Read + write in the transaction also supports legacy Mongo documents
        // without this field; concurrent changes conflict instead of losing a revision.
        const current = scheduleChanged
          ? await tx.ticketType.findUniqueOrThrow({ where: { id } })
          : null;
        const ticketType = await tx.ticketType.update({
          where: { id },
          data: {
            ...data,
            ...(current
              ? {
                  salesScheduleVersion: (current.salesScheduleVersion ?? 0) + 1,
                }
              : {}),
          },
          include: { session: { select: { currency: true } } },
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
              ...(scheduleChanged
                ? {
                    salesStartAt:
                      ticketType.salesStartAt?.toISOString() ?? null,
                    salesScheduleVersion: ticketType.salesScheduleVersion,
                    // Allows inventory to initialize even if update beats create across topics.
                    inventorySnapshot: {
                      sessionId: ticketType.sessionId,
                      name: ticketType.name,
                      code: ticketType.code,
                      price: ticketType.price,
                      currency: ticketType.session?.currency ?? 'USD',
                      quantity: ticketType.quantity,
                      status: ticketType.status,
                    },
                  }
                : {}),
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

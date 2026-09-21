import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateTicketTypeData = {
  sessionId: string;
  name: string;
  code: string;
  price: number;
  currency: string;
  quantity: number;
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
}

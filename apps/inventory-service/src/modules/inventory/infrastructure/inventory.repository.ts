import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/inventory-prisma';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RpcException } from '@nestjs/microservices';

export type CreateInventoryData = {
  ticketTypeId: string;
  name?: string;
  code?: string;
  price?: number;
  currency?: string;
  total: number;
};
export type ReserveInventoryData = {
  ticketTypeId: string;
  quantity: number;
  bookingId: string;
  userId: string;
};
export type ReleaseInventoryData = {
  reservationId: string;
  bookingId: string;
};
@Injectable()
export class InventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateInventoryData) {
    try {
      return await this.prisma.inventory.create({
        data: {
          ticketTypeId: data.ticketTypeId,
          name: data.name,
          code: data.code,
          price: data.price,
          currency: data.currency,
          total: data.total,
          available: data.total,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.findByTicketTypeId(data.ticketTypeId);
      }

      throw error;
    }
  }

  findByTicketTypeId(ticketTypeId: string) {
    return this.prisma.inventory.findUnique({
      where: { ticketTypeId },
      include: { holds: true },
    });
  }
  async reserve(data: ReserveInventoryData) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.inventory.updateMany({
        where: {
          ticketTypeId: data.ticketTypeId,
          available: {
            gte: data.quantity,
          },
        },
        data: {
          available: {
            decrement: data.quantity,
          },
          reserved: {
            increment: data.quantity,
          },
          version: {
            increment: 1,
          },
        },
      });
      if (result.count !== 1) {
        throw new RpcException({
          code: 8,
          message: 'Not enough inventory',
        });
      }
      const inventory = await tx.inventory.findUniqueOrThrow({
        where: {
          ticketTypeId: data.ticketTypeId,
        },
      });
      const hold = await tx.inventoryHold.create({
        data: {
          inventoryId: inventory.id,
          bookingId: data.bookingId,
          userId: data.userId,
          quantity: data.quantity,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      return { hold, inventory };
    });
  }

  async release(data: ReleaseInventoryData) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.inventoryHold.updateMany({
        where: {
          id: data.reservationId,
          bookingId: data.bookingId,
          status: 'ACTIVE',
        },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (result.count !== 1) {
        return { released: false as const };
      }
      const hold = await tx.inventoryHold.findUniqueOrThrow({
        where: { id: data.reservationId },
      });
      await tx.inventory.update({
        where: { id: hold.inventoryId },
        data: {
          available: { increment: hold.quantity },
          reserved: { decrement: hold.quantity },
          version: { increment: 1 },
        },
      });
      return { released: true as const, hold };
    });
  }
}

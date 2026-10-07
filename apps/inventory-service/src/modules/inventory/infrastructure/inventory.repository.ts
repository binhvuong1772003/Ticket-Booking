import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/inventory-prisma';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RpcException } from '@nestjs/microservices';

export type CreateInventoryData = {
  ticketTypeId: string;
  sessionId?: string;
  sessionActive?: boolean;
  name?: string;
  code?: string;
  price?: number;
  currency?: string;
  total: number;
  salesStartAt?: Date | null;
  salesScheduleVersion?: number;
  typeActive?: boolean;
};
export type ReserveInventoryData = {
  ticketTypeId: string;
  sessionId: string;
  eventId: string;
  quantity: number;
  bookingId: string;
  userId: string;
};
export type ReleaseInventoryData = {
  reservationId: string;
  bookingId: string;
};
export type ConfirmInventoryData = {
  reservationId: string;
  bookingId: string;
};
@Injectable()
export class InventoryRepository {
  private readonly logger = new Logger(InventoryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateInventoryData) {
    try {
      return await this.prisma.inventory.create({
        data: {
          ticketTypeId: data.ticketTypeId,
          sessionId: data.sessionId,
          sessionActive: data.sessionActive ?? false,
          name: data.name,
          code: data.code,
          price: data.price,
          currency: data.currency,
          total: data.total,
          salesStartAt: data.salesStartAt ?? null,
          salesScheduleVersion: data.salesScheduleVersion ?? 0,
          typeActive: data.typeActive ?? true,
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

  async getAvailability(ticketTypes: { ticketTypeId: string; sessionId: string }[]) {
    const sessionByTicketType = new Map(
      ticketTypes.map((item) => [item.ticketTypeId, item.sessionId]),
    );
    const now = new Date();
    const inventories = await this.prisma.inventory.findMany({
      where: { ticketTypeId: { in: [...sessionByTicketType.keys()] } },
      select: {
        ticketTypeId: true,
        sessionId: true,
        total: true,
        available: true,
        sold: true,
        sessionActive: true,
        typeActive: true,
        salesStartAt: true,
        holds: {
          where: { status: 'ACTIVE', expiresAt: { lte: now } },
          select: { quantity: true },
        },
      },
    });
    return inventories.flatMap((inventory) => {
      if (inventory.sessionId !== sessionByTicketType.get(inventory.ticketTypeId)) {
        return [];
      }
      const expiredHolds = inventory.holds.reduce(
        (quantity, hold) => quantity + hold.quantity,
        0,
      );
      const onSale =
        inventory.sessionActive &&
        inventory.typeActive &&
        (!inventory.salesStartAt || inventory.salesStartAt <= now);
      return [{
        ticketTypeId: inventory.ticketTypeId,
        sessionId: inventory.sessionId,
        availableQuantity: onSale
          ? Math.max(
              0,
              Math.min(
                inventory.total - inventory.sold,
                inventory.available + expiredHolds,
              ),
            )
          : 0,
      }];
    });
  }

  async reserve(data: ReserveInventoryData) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const initialInventory = await tx.inventory.findUnique({
        where: { ticketTypeId: data.ticketTypeId },
      });
      if (!initialInventory) {
        throw new RpcException({ code: 3, message: 'Ticket type not found' });
      }
      if (!initialInventory.sessionId) {
        throw new RpcException({
          code: 14,
          message: 'Ticket type session mapping is not ready',
        });
      }
      if (initialInventory.sessionId !== data.sessionId) {
        throw new RpcException({
          code: 3,
          message: 'Ticket type does not belong to the requested session',
        });
      }

      const catalog = await tx.sessionCatalog.findUnique({
        where: { sessionId: initialInventory.sessionId },
      });
      if (!catalog?.eventId) {
        throw new RpcException({
          code: 14,
          message: 'Session event mapping is not ready',
        });
      }
      if (catalog.eventId !== data.eventId) {
        throw new RpcException({
          code: 3,
          message: 'Session does not belong to the requested event',
        });
      }

      const result = await tx.inventory.updateMany({
        where: {
          ticketTypeId: data.ticketTypeId,
          // Keep the checked ticket type → session binding in the atomic write.
          sessionId: initialInventory.sessionId,
          // Cổng bán: session đã SCHEDULED + hạng vé chưa bị ẩn/xóa.
          sessionActive: true,
          typeActive: true,
          available: {
            gte: data.quantity,
          },
          OR: [
            { salesStartAt: { lte: now } },
            { salesStartAt: null },
            // MongoDB legacy documents may not have the field at all.
            { salesStartAt: { isSet: false } },
          ],
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
        const inventory = await tx.inventory.findUnique({
          where: { ticketTypeId: data.ticketTypeId },
        });
        if (!inventory) {
          throw new RpcException({ code: 3, message: 'Ticket type not found' });
        }
        if (!inventory.sessionId) {
          throw new RpcException({
            code: 14,
            message: 'Ticket type session mapping is not ready',
          });
        }
        if (inventory.sessionId !== data.sessionId) {
          throw new RpcException({
            code: 3,
            message: 'Ticket type does not belong to the requested session',
          });
        }
        if (!inventory.sessionActive || !inventory.typeActive) {
          throw new RpcException({
            code: 9,
            message: 'Ticket type is not on sale',
          });
        }
        if (inventory.salesStartAt && inventory.salesStartAt > now) {
          throw new RpcException({
            code: 9,
            message: 'Ticket sales have not started',
          });
        }
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
      return {
        hold,
        inventory,
        ticketTypeId: inventory.ticketTypeId,
        sessionId: initialInventory.sessionId,
        eventId: catalog.eventId,
      };
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
        const hold = await tx.inventoryHold.findUnique({
          where: { id: data.reservationId },
        });
        if (
          ['RELEASED', 'EXPIRED'].includes(hold?.status ?? '') &&
          hold?.bookingId === data.bookingId
        ) {
          return { released: true as const, alreadyReleased: true };
        }
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

  async confirm(data: ConfirmInventoryData) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.inventoryHold.updateMany({
        where: {
          id: data.reservationId,
          bookingId: data.bookingId,
          status: 'ACTIVE',
        },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      if (result.count !== 1) {
        const hold = await tx.inventoryHold.findUnique({
          where: { id: data.reservationId },
        });
        // Idempotent: Kafka/gRPC retry của cùng 1 booking coi là thành công.
        if (hold?.status === 'CONFIRMED' && hold.bookingId === data.bookingId) {
          return { confirmed: true as const, alreadyConfirmed: true };
        }
        return { confirmed: false as const };
      }
      const hold = await tx.inventoryHold.findUniqueOrThrow({
        where: { id: data.reservationId },
      });
      await tx.inventory.update({
        where: { id: hold.inventoryId },
        data: {
          reserved: { decrement: hold.quantity },
          sold: { increment: hold.quantity },
          version: { increment: 1 },
        },
      });
      return { confirmed: true as const, hold };
    });
  }

  /**
   * Trả vé đã bán về kho: hold CONFIRMED → RELEASED, sold--, available++.
   * Chỉ gọi sau khi refund đã xong (payment.refunded) — ghế không trả sớm
   * để tránh oversell khi refund fail. Idempotent theo (id, bookingId).
   */
  async revoke(data: ReleaseInventoryData) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.inventoryHold.updateMany({
        where: {
          id: data.reservationId,
          bookingId: data.bookingId,
          status: 'CONFIRMED',
        },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      if (result.count !== 1) {
        const hold = await tx.inventoryHold.findUnique({
          where: { id: data.reservationId },
        });
        if (
          ['RELEASED', 'EXPIRED'].includes(hold?.status ?? '') &&
          hold?.bookingId === data.bookingId
        ) {
          return { revoked: true as const, alreadyRevoked: true };
        }
        return { revoked: false as const };
      }
      const hold = await tx.inventoryHold.findUniqueOrThrow({
        where: { id: data.reservationId },
      });
      await tx.inventory.update({
        where: { id: hold.inventoryId },
        data: {
          available: { increment: hold.quantity },
          sold: { decrement: hold.quantity },
          version: { increment: 1 },
        },
      });
      return { revoked: true as const, hold };
    });
  }

  /* Đồng bộ field denormalized từ ticket-type.updated. quantity →
     available = total mới - reserved - sold (bình thường update chỉ xảy
     ra khi session DRAFT nên reserved=sold=0; vẫn trừ để tự chữa nếu có
     hold sót — clamp 0 thay vì âm, log cho ops đối soát). */
  async applyTicketTypeUpdate(
    ticketTypeId: string,
    fields: {
      name?: string;
      code?: string;
      price?: number;
      currency?: string;
      quantity?: number;
      typeActive?: boolean;
      salesStartAt?: Date | null;
      salesScheduleVersion?: number;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const inventory = await tx.inventory.findUnique({
        where: { ticketTypeId },
      });
      if (!inventory) {
        return { updated: false as const };
      }

      const data: Prisma.InventoryUpdateInput = {};
      if (
        fields.salesStartAt !== undefined &&
        fields.salesScheduleVersion !== undefined &&
        fields.salesScheduleVersion > (inventory.salesScheduleVersion ?? 0)
      ) {
        data.salesStartAt = fields.salesStartAt;
        data.salesScheduleVersion = fields.salesScheduleVersion;
      }
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.code !== undefined) data.code = fields.code;
      if (fields.price !== undefined) data.price = fields.price;
      if (fields.currency !== undefined) data.currency = fields.currency;
      if (fields.typeActive !== undefined) data.typeActive = fields.typeActive;

      if (fields.quantity !== undefined) {
        const newAvailable =
          fields.quantity - inventory.reserved - inventory.sold;
        if (newAvailable < 0) {
          this.logger.error(
            `quantity update for ${ticketTypeId} would make ` +
              `available negative (${fields.quantity} - ${inventory.reserved} - ${inventory.sold}); clamped to 0`,
          );
        }
        data.total = fields.quantity;
        data.available = Math.max(0, newAvailable);
      }

      if (Object.keys(data).length === 0) {
        return { updated: false as const };
      }

      data.version = { increment: 1 };
      await tx.inventory.update({ where: { ticketTypeId }, data });
      return { updated: true as const };
    });
  }

  // Tombstone: không xóa hẳn để chống race created-đến-sau-deleted —
  // stub row (available=0, typeActive=false) giữ chỗ, P2002 chặn recreate.
  async tombstoneByTicketTypeId(ticketTypeId: string) {
    return this.prisma.inventory.upsert({
      where: { ticketTypeId },
      create: {
        ticketTypeId,
        total: 0,
        available: 0,
        sessionActive: false,
        typeActive: false,
      },
      update: { typeActive: false },
    });
  }

  async upsertSessionCatalog(
    sessionId: string,
    status: string,
    eventId?: string,
  ) {
    const catalog = await this.prisma.sessionCatalog.upsert({
      where: { sessionId },
      create: { sessionId, status, ...(eventId ? { eventId } : {}) },
      update: { status },
    });
    if (eventId) {
      // Atomic compare-and-set: status always updates above, but a binding
      // may only be filled once (or confirmed with the same event).
      await this.prisma.sessionCatalog.updateMany({
        where: {
          sessionId,
          OR: [
            { eventId: null },
            { eventId: { isSet: false } },
            { eventId },
          ],
        },
        data: { eventId },
      });
    }
    return catalog;
  }

  async sessionStatusOf(sessionId: string) {
    const catalog = await this.prisma.sessionCatalog.findUnique({
      where: { sessionId },
    });
    return catalog?.status ?? null;
  }

  async setSessionActive(sessionId: string, active: boolean) {
    return this.prisma.inventory.updateMany({
      where: { sessionId },
      data: { sessionActive: active, version: { increment: 1 } },
    });
  }

  async expireHolds(now: Date, take: number) {
    const holds = await this.prisma.inventoryHold.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      select: { id: true },
      take,
    });

    let expired = 0;
    for (const { id } of holds) {
      const done = await this.prisma.$transaction(async (tx) => {
        const result = await tx.inventoryHold.updateMany({
          where: { id, status: 'ACTIVE' },
          data: { status: 'EXPIRED' },
        });
        if (result.count !== 1) {
          return false;
        }
        const hold = await tx.inventoryHold.findUniqueOrThrow({
          where: { id },
        });
        await tx.inventory.update({
          where: { id: hold.inventoryId },
          data: {
            available: { increment: hold.quantity },
            reserved: { decrement: hold.quantity },
            version: { increment: 1 },
          },
        });
        return true;
      });
      if (done) {
        expired++;
      }
    }
    return expired;
  }
}

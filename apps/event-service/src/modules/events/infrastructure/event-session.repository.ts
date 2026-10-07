import { Injectable } from '@nestjs/common';
import { EventSessionStatus, Prisma, TicketTypeStatus } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateEventSessionData = {
  eventId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  placeId?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
  currency: string;
};

export type UpdateEventSessionData = {
  id: string;
  ownerId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  placeId?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
  currency?: string;
};

// Allowlist field được sửa sau khi session đã SCHEDULED.
export type RescheduleSessionData = {
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  placeId?: string | null;
};

export type EventSessionFilter = {
  city?: string;
  countryCode?: string | null;
  placeId?: string | null;
  startsAtFrom?: Date;
  startsAtTo?: Date;
  status?: EventSessionStatus;
};

@Injectable()
export class EventsSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPage(input: {
    eventId: string;
    first: number;
    afterId?: string;
    includeDrafts: boolean;
    filter: EventSessionFilter;
  }) {
    const statusConditions: Prisma.EventSessionWhereInput[] = [];
    if (!input.includeDrafts) {
      statusConditions.push({ status: { not: EventSessionStatus.DRAFT } });
    }
    if (input.filter.status) {
      statusConditions.push({ status: input.filter.status });
    }

    const where: Prisma.EventSessionWhereInput = {
      eventId: input.eventId,
      ...(input.filter.city && {
        city: { contains: input.filter.city, mode: 'insensitive' },
      }),
      ...(input.filter.countryCode && {
        countryCode: input.filter.countryCode,
      }),
      ...(input.filter.placeId && { placeId: input.filter.placeId }),
      ...((input.filter.startsAtFrom || input.filter.startsAtTo) && {
        startsAt: {
          ...(input.filter.startsAtFrom && { gte: input.filter.startsAtFrom }),
          ...(input.filter.startsAtTo && { lte: input.filter.startsAtTo }),
        },
      }),
      ...(statusConditions.length > 0 && { AND: statusConditions }),
    };

    return this.prisma.eventSession.findMany({
      where,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: input.first,
      ...(input.afterId && { cursor: { id: input.afterId }, skip: 1 }),
      include: {
        ticketTypes: {
          ...(!input.includeDrafts && {
            where: { status: { not: TicketTypeStatus.INACTIVE } },
          }),
        },
      },
    });
  }

  async create(data: CreateEventSessionData) {
    try {
      return await this.prisma.eventSession.create({
        data: {
          eventId: data.eventId,
          name: data.name,
          venueName: data.venueName,
          venueAddress: data.venueAddress,
          city: data.city,
          countryCode: data.countryCode,
          placeId: data.placeId,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          timezone: data.timezone ?? undefined,
          capacity: data.capacity,
          currency: data.currency,
        },
      });
    } catch {
      throw new ApiError(
        'Failed to create event session',
        'INTERNAL_SERVER_ERROR',
      );
    }
  }

  findByIdAndOwner(id: string, ownerId: string) {
    return this.prisma.eventSession.findFirst({
      where: {
        id,
        event: { ownerId },
      },
      include: {
        event: {
          select: { status: true },
        },
      },
    });
  }

  async update(data: UpdateEventSessionData) {
    const session = await this.findByIdAndOwner(data.id, data.ownerId);

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.eventSession.updateMany({
        where: {
          id: data.id,
          // Chỉ session nháp mới được sửa toàn bộ field — sau khi SCHEDULED
          // (đã công bố) mọi nội dung bị khóa, chỉ reschedule() còn mở.
          status: EventSessionStatus.DRAFT,
        },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.venueName !== undefined && { venueName: data.venueName }),
          ...(data.venueAddress !== undefined && {
            venueAddress: data.venueAddress,
          }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.countryCode !== undefined && {
            countryCode: data.countryCode,
          }),
          ...(data.placeId !== undefined && { placeId: data.placeId }),
          ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
          ...(data.endsAt !== undefined && { endsAt: data.endsAt }),
          ...(data.timezone !== undefined && {
            timezone: data.timezone ?? undefined,
          }),
          ...(data.capacity !== undefined && { capacity: data.capacity }),
          ...(data.currency !== undefined && { currency: data.currency }),
        },
      });

      if (result.count !== 1) {
        throw new ApiError('Event session was changed or removed', 'CONFLICT');
      }

      // Currency sống ở session: khi đổi, emit ticket-type.updated cho mọi
      // type để downstream (inventory) đồng bộ bản sao currency.
      if (data.currency !== undefined && data.currency !== session.currency) {
        const types = await tx.ticketType.findMany({
          where: { sessionId: data.id },
          select: { id: true },
        });
        await tx.outboxEvent.createMany({
          data: types.map((type) => ({
            aggregateId: type.id,
            eventType: 'ticket-type.updated',
            aggregateVersion: 1,
            payload: {
              ticketTypeId: type.id,
              sessionId: data.id,
              currency: data.currency,
            },
          })),
        });
      }

      return tx.eventSession.findUniqueOrThrow({
        where: { id: data.id },
      });
    });
  }

  async updateStatus(
    id: string,
    ownerId: string,
    fromStatus: EventSessionStatus,
    toStatus: EventSessionStatus,
    cancellationReason?: string | null,
  ) {
    const session = await this.assertOwned(id, ownerId);

    const data: {
      status: EventSessionStatus;
      cancelledAt?: Date;
      cancellationReason?: string | null;
    } = {
      status: toStatus,
    };

    if (toStatus === EventSessionStatus.CANCELLED) {
      data.cancelledAt = new Date();
      data.cancellationReason = cancellationReason;
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.eventSession.updateMany({
        where: {
          id,
          status: fromStatus,
        },
        data,
      });

      if (updated.count !== 1) {
        throw new ApiError(
          'Event session state changed or session not found',
          'CONFLICT',
        );
      }

      // Inventory-service nghe event này để bật/tắt bán: chỉ SCHEDULED mới
      // cho reserve. Emit trong cùng tx để không bao giờ lệch trạng thái.
      await tx.outboxEvent.create({
        data: {
          aggregateId: session.id,
          eventType: 'session.status.changed',
          aggregateVersion: 1,
          schemaVersion: 1,
          payload: {
            sessionId: session.id,
            eventId: session.eventId,
            status: toStatus,
          },
        },
      });
    });

    return this.prisma.eventSession.findUniqueOrThrow({
      where: { id },
    });
  }

  /* Đổi giờ/địa điểm sau khi đã công bố — allowlist duy nhất còn mở ở
     SCHEDULED. Emit session.rescheduled để sau này notify người đã mua. */
  async reschedule(id: string, ownerId: string, data: RescheduleSessionData) {
    const session = await this.findByIdAndOwner(id, ownerId);

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.eventSession.updateMany({
        where: { id, status: EventSessionStatus.SCHEDULED },
        data: {
          ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
          ...(data.endsAt !== undefined && { endsAt: data.endsAt }),
          ...(data.timezone !== undefined && {
            timezone: data.timezone ?? undefined,
          }),
          ...(data.venueName !== undefined && { venueName: data.venueName }),
          ...(data.venueAddress !== undefined && {
            venueAddress: data.venueAddress,
          }),
          ...(data.city !== undefined && { city: data.city }),
          ...(data.countryCode !== undefined && {
            countryCode: data.countryCode,
          }),
          ...(data.placeId !== undefined && { placeId: data.placeId }),
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        throw new ApiError(
          'Only scheduled sessions can be rescheduled',
          'CONFLICT',
        );
      }

      const updated = await tx.eventSession.findUniqueOrThrow({
        where: { id },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: session.id,
          eventType: 'session.rescheduled',
          aggregateVersion: updated.version,
          schemaVersion: 1,
          payload: {
            sessionId: session.id,
            eventId: session.eventId,
            version: updated.version,
            startsAt: data.startsAt,
            endsAt: data.endsAt,
            timezone: data.timezone,
            venueName: data.venueName,
            venueAddress: data.venueAddress,
            city: data.city,
            countryCode: data.countryCode,
            placeId: data.placeId,
          },
        },
      });

      return updated;
    });
  }

  // Session còn sống = DRAFT hoặc SCHEDULED — event chỉ archive được khi
  // không còn session nào đang mở (archive là housekeeping sau sự kiện).
  countLiveSessions(eventId: string) {
    return this.prisma.eventSession.count({
      where: {
        eventId,
        status: {
          in: [EventSessionStatus.DRAFT, EventSessionStatus.SCHEDULED],
        },
      },
    });
  }

  private async assertOwned(id: string, ownerId: string) {
    const session = await this.findByIdAndOwner(id, ownerId);

    if (!session) {
      throw new ApiError('Event session not found', 'NOT_FOUND');
    }

    return session;
  }
}

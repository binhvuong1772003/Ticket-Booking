import { Injectable } from '@nestjs/common';
import { EventSessionStatus } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';

export type CreateEventSessionData = {
  eventId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
};

export type UpdateEventSessionData = {
  id: string;
  ownerId: string;
  name?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  countryCode?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  timezone?: string | null;
  capacity?: number | null;
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
};

@Injectable()
export class EventsSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

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
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          timezone: data.timezone ?? undefined,
          capacity: data.capacity,
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

    const result = await this.prisma.eventSession.updateMany({
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
        ...(data.startsAt !== undefined && { startsAt: data.startsAt }),
        ...(data.endsAt !== undefined && { endsAt: data.endsAt }),
        ...(data.timezone !== undefined && {
          timezone: data.timezone ?? undefined,
        }),
        ...(data.capacity !== undefined && { capacity: data.capacity }),
      },
    });

    if (result.count !== 1) {
      throw new ApiError('Event session was changed or removed', 'CONFLICT');
    }

    return this.prisma.eventSession.findUniqueOrThrow({
      where: { id: data.id },
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
        },
      });

      if (result.count !== 1) {
        throw new ApiError(
          'Only scheduled sessions can be rescheduled',
          'CONFLICT',
        );
      }

      await tx.outboxEvent.create({
        data: {
          aggregateId: session.id,
          eventType: 'session.rescheduled',
          aggregateVersion: 1,
          schemaVersion: 1,
          payload: {
            sessionId: session.id,
            eventId: session.eventId,
            startsAt: data.startsAt,
            endsAt: data.endsAt,
            timezone: data.timezone,
            venueName: data.venueName,
            venueAddress: data.venueAddress,
            city: data.city,
            countryCode: data.countryCode,
          },
        },
      });

      return tx.eventSession.findUniqueOrThrow({ where: { id } });
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

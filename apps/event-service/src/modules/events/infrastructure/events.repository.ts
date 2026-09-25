import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';
import { Prisma, EventSessionStatus, EventStatus } from '@prisma/client';

export type CreateEventData = {
  ownerId: string;
  title: string;
  slug: string;
  summary?: string;
  organizerDisplayName?: string;
  contactEmail?: string;
  contactPhone?: string;
  coverImageUrl?: string;
};
export type UpdateEventData = {
  ownerId: string;
  id: string;
  title?: string;
  slug?: string;
  summary?: string | null;
  organizerDisplayName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  coverImageUrl?: string | null;
};

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPublished() {
    return this.prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
    });
  }

  /* Sessions+ticketTypes included so the organizer dashboard can derive
     sold/revenue without one query per event. */
  findByOwner(ownerId: string) {
    return this.prisma.event.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: {
        sessions: {
          orderBy: { startsAt: 'asc' },
          include: { ticketTypes: true },
        },
      },
    });
  }

  findById(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        sessions: {
          orderBy: { startsAt: 'asc' },
          include: { ticketTypes: true },
        },
      },
    });
  }

  async create(data: CreateEventData) {
    try {
      return await this.prisma.event.create({
        data: {
          ownerId: data.ownerId,
          title: data.title,
          slug: data.slug,
          summary: data.summary,
          organizerDisplayName: data.organizerDisplayName,
          contactEmail: data.contactEmail,
          contactPhone: data.contactPhone,
          coverImageUrl: data.coverImageUrl,
          status: 'DRAFT',
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError('Slug already exists', 'CONFLICT', {
          field: 'slug',
        });
      }

      throw error;
    }
  }
  async update(data: UpdateEventData) {
    try {
      const result = await this.prisma.event.updateMany({
        where: {
          id: data.id,
          ownerId: data.ownerId,
        },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(data.summary !== undefined && { summary: data.summary }),
          ...(data.organizerDisplayName !== undefined && {
            organizerDisplayName: data.organizerDisplayName,
          }),
          ...(data.contactEmail !== undefined && {
            contactEmail: data.contactEmail,
          }),
          ...(data.contactPhone !== undefined && {
            contactPhone: data.contactPhone,
          }),
          ...(data.coverImageUrl !== undefined && {
            coverImageUrl: data.coverImageUrl,
          }),
          version: {
            increment: 1,
          },
        },
      });

      if (result.count !== 1) {
        throw new ApiError('Event not found', 'NOT_FOUND');
      }

      return this.prisma.event.findUniqueOrThrow({
        where: { id: data.id },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiError('Slug already exists', 'CONFLICT', {
          field: 'slug',
        });
      }

      throw error;
    }
  }
  async updateStatus(
    id: string,
    ownerId: string,
    fromStatus: EventStatus,
    toStatus: EventStatus,
    cancellationReason?: string | null,
    version?: number,
  ) {
    const now = new Date();
    const data: Prisma.EventUpdateManyMutationInput = {
      status: toStatus,
      version: {
        increment: 1,
      },
    };
    switch (toStatus) {
      case EventStatus.PUBLISHED:
        data.publishedAt = now;
        break;
      case EventStatus.ARCHIVED:
        data.archivedAt = now;
        break;
      case EventStatus.CANCELLED:
        data.cancelledAt = now;
        if (cancellationReason) {
          data.cancellationReason = cancellationReason;
        }
        break;
    }
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.event.updateMany({
        where: {
          id,
          ownerId,
          status: fromStatus,
        },
        data,
      });

      if (result.count !== 1) {
        throw new ApiError(
          'Event state changed or event not found',
          'CONFLICT',
        );
      }

      if (toStatus === EventStatus.PUBLISHED) {
        // booking-service nghe event này để dựng EventCatalog projection
        // (eventId → organizerId) phục vụ ownership check cho các query
        // đọc booking của organizer.
        await tx.outboxEvent.create({
          data: {
            aggregateId: id,
            eventType: 'event.published',
            aggregateVersion: (version ?? 0) + 1,
            payload: {
              event_id: id,
              organizer_id: ownerId,
            },
          },
        });
      }

      if (toStatus === EventStatus.CANCELLED) {
        // Cascade session → CANCELLED và emit session.status.changed cho
        // từng session — inventory-service nghe event này để tắt
        // sessionActive, chặn bán vé trên event đã hủy.
        const sessions = await tx.eventSession.findMany({
          where: { eventId: id, status: { not: EventSessionStatus.CANCELLED } },
          select: { id: true },
        });
        await tx.eventSession.updateMany({
          where: {
            eventId: id,
            status: { not: EventStatus.CANCELLED },
          },
          data: {
            status: EventStatus.CANCELLED,
            cancelledAt: now,
            ...(cancellationReason && { cancellationReason }),
          },
        });
        for (const session of sessions) {
          await tx.outboxEvent.create({
            data: {
              aggregateId: session.id,
              eventType: 'session.status.changed',
              aggregateVersion: 1,
              schemaVersion: 1,
              payload: {
                sessionId: session.id,
                eventId: id,
                status: EventSessionStatus.CANCELLED,
              },
            },
          });
        }

        // Fact 'event.cancelled' trong cùng tx: booking-service cascade —
        // booking PENDING → cancel+release hold, CONFIRMED+PAID → refund.
        await tx.outboxEvent.create({
          data: {
            aggregateId: id,
            eventType: 'event.cancelled',
            aggregateVersion: (version ?? 0) + 1,
            payload: {
              event_id: id,
              reason: cancellationReason ?? null,
            },
          },
        });
      }
    });

    return this.prisma.event.findUniqueOrThrow({
      where: { id },
    });
  }
  findByIdAndOwner(id: string, ownerId: string) {
    return this.prisma.event.findFirst({
      where: {
        id,
        ownerId,
      },
    });
  }

  // Outbox cho lệnh refund do organizer chủ động — booking-service consume
  // 'booking.refund.requested' và verify booking.eventId khớp event_id.
  emitRefundRequest(input: {
    eventId: string;
    aggregateVersion: number;
    bookingId: string;
    reason?: string;
    requestedBy: string;
  }) {
    return this.prisma.outboxEvent.create({
      data: {
        aggregateId: input.eventId,
        eventType: 'booking.refund.requested',
        aggregateVersion: input.aggregateVersion,
        payload: {
          booking_id: input.bookingId,
          event_id: input.eventId,
          reason: input.reason ?? null,
          requested_by: input.requestedBy,
        },
      },
    });
  }
}

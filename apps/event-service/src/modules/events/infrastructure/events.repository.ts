import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ApiError } from '../../../common/errors/api-error';
import {
  EventSessionStatus,
  EventStatus,
  Prisma,
  TicketTypeStatus,
} from '@prisma/client';

export type CreateEventData = {
  ownerId: string;
  title: string;
  slug: string;
  summary?: string;
  organizerDisplayName?: string;
  contactEmail?: string;
  contactPhone?: string;
  coverImageUrl?: string;
  posterImageUrl?: string;
  categoryId?: string;
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
  posterImageUrl?: string | null;
  categoryId?: string | null;
};

export type PublishedEventFilter = {
  categoryId?: string;
  q?: string;
  city?: string;
  countryCode?: string | null;
  placeId?: string | null;
  startsAtFrom?: Date;
  startsAtTo?: Date;
  upcomingOnly?: boolean;
};

export type PublishedEventPageRow = Omit<
  Prisma.EventGetPayload<{
    include: { sessions: { include: { ticketTypes: true } } };
  }>,
  'sessions'
> & {
  sessions?: Prisma.EventGetPayload<{
    include: { sessions: { include: { ticketTypes: true } } };
  }>['sessions'];
};

function eventSessionConstraints(
  filter: Pick<
    PublishedEventFilter,
    'city' | 'countryCode' | 'placeId' | 'startsAtFrom' | 'startsAtTo'
  >,
) {
  return {
    ...(filter.city && {
      city: { contains: filter.city, mode: 'insensitive' as const },
    }),
    ...(filter.countryCode && { countryCode: filter.countryCode }),
    ...(filter.placeId && { placeId: filter.placeId }),
    ...((filter.startsAtFrom || filter.startsAtTo) && {
      startsAt: {
        ...(filter.startsAtFrom && { gte: filter.startsAtFrom }),
        ...(filter.startsAtTo && { lte: filter.startsAtTo }),
      },
    }),
  };
}

function upcomingSessionWhere(
  filter: Pick<
    PublishedEventFilter,
    'city' | 'countryCode' | 'placeId' | 'startsAtFrom' | 'startsAtTo'
  >,
  now: Date,
): Prisma.EventSessionWhereInput {
  return {
    status: EventSessionStatus.SCHEDULED,
    ...eventSessionConstraints(filter),
    startsAt: {
      gt: now,
      ...(filter.startsAtFrom && { gte: filter.startsAtFrom }),
      ...(filter.startsAtTo && { lte: filter.startsAtTo }),
    },
  };
}

function publicSessionInclude(
  where: Prisma.EventSessionWhereInput,
  take?: number,
) {
  return {
    where,
    orderBy: [{ startsAt: 'asc' as const }, { id: 'asc' as const }],
    ...(take !== undefined && { take }),
    include: {
      ticketTypes: {
        where: { status: { not: TicketTypeStatus.INACTIVE } },
      },
    },
  };
}

@Injectable()
export class EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findPublished(includeAvailabilitySummary = false) {
    return this.prisma.event.findMany({
      where: { status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      ...(includeAvailabilitySummary && {
        include: {
          sessions: publicSessionInclude({
            status: { not: EventSessionStatus.DRAFT },
          }),
        },
      }),
    });
  }

  findPublishedPage(input: {
    first: number;
    now?: Date;
    afterId?: string;
    includeSessions?: boolean;
    includeSummary?: boolean;
    filter: PublishedEventFilter;
  }): Promise<PublishedEventPageRow[]> {
    const now = input.now ?? new Date();
    const nextSessionWhere = upcomingSessionWhere(input.filter, now);
    const locationFiltered = Boolean(
      input.filter.countryCode || input.filter.placeId,
    );
    const sessionWhere: Prisma.EventSessionWhereInput = {
      ...(input.filter.upcomingOnly || locationFiltered
        ? nextSessionWhere
        : {
            status: { not: EventSessionStatus.DRAFT },
            ...eventSessionConstraints(input.filter),
          }),
    };
    const hasSessionFilter = Boolean(
      input.filter.upcomingOnly ||
        input.filter.city ||
        input.filter.countryCode ||
        input.filter.placeId ||
        input.filter.startsAtFrom ||
        input.filter.startsAtTo,
    );
    const where: Prisma.EventWhereInput = {
      status: EventStatus.PUBLISHED,
      ...(input.filter.categoryId && {
        categoryId: input.filter.categoryId,
        category: { is: { isActive: true } },
      }),
      ...(input.filter.q && {
        OR: [
          { title: { contains: input.filter.q, mode: 'insensitive' } },
          { slug: { contains: input.filter.q, mode: 'insensitive' } },
          { summary: { contains: input.filter.q, mode: 'insensitive' } },
        ],
      }),
      ...(hasSessionFilter && { sessions: { some: sessionWhere } }),
    };

    return this.prisma.event.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: input.first,
      ...(input.afterId && { cursor: { id: input.afterId }, skip: 1 }),
      ...((input.includeSessions || input.includeSummary) && {
        include: {
          sessions: publicSessionInclude(
            input.includeSessions || locationFiltered
              ? sessionWhere
              : nextSessionWhere,
            input.includeSessions ? undefined : 1,
          ),
        },
      }),
    });
  }

  findFeaturedEvents(input: { first: number; now: Date; city?: string }) {
    const sessionWhere = upcomingSessionWhere(
      { city: input.city },
      input.now,
    );
    return this.prisma.event.findMany({
      where: {
        status: EventStatus.PUBLISHED,
        featuredOrder: { not: null },
        sessions: { some: sessionWhere },
      },
      orderBy: [{ featuredOrder: 'asc' }, { id: 'asc' }],
      take: input.first,
      include: {
        sessions: publicSessionInclude(sessionWhere, 1),
      },
    });
  }

  findPublicUpcomingEventsByIds(input: {
    eventIds: string[];
    now: Date;
    city?: string;
  }): Promise<PublishedEventPageRow[]> {
    if (!input.eventIds.length) return Promise.resolve([]);
    const sessionWhere = upcomingSessionWhere(
      { city: input.city },
      input.now,
    );
    return this.prisma.event.findMany({
      where: {
        id: { in: input.eventIds },
        status: EventStatus.PUBLISHED,
        sessions: { some: sessionWhere },
      },
      include: {
        sessions: publicSessionInclude(sessionWhere, 1),
      },
    });
  }

  async setFeaturedOrder(eventId: string, featuredOrder: number | null) {
    const result = await this.prisma.event.updateMany({
      where: { id: eventId },
      data: { featuredOrder },
    });
    if (result.count !== 1) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }
    return this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
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

  findVisibilityById(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      select: { ownerId: true, status: true },
    });
  }

  async create(data: CreateEventData) {
    try {
      if (data.categoryId) {
        await this.requireActiveCategory(data.categoryId);
      }
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
          posterImageUrl: data.posterImageUrl,
          categoryId: data.categoryId,
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
      if (data.categoryId) {
        await this.requireActiveCategory(data.categoryId);
      }
      const result = await this.prisma.event.updateMany({
        where: {
          id: data.id,
          ownerId: data.ownerId,
          ...(data.posterImageUrl === null && { status: EventStatus.DRAFT }),
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
          ...(data.categoryId !== undefined && {
            categoryId: data.categoryId,
          }),
          ...(data.posterImageUrl !== undefined && {
            posterImageUrl: data.posterImageUrl,
          }),
          version: {
            increment: 1,
          },
        },
      });

      if (result.count !== 1) {
        if (data.posterImageUrl === null) {
          const event = await this.prisma.event.findFirst({
            where: { id: data.id, ownerId: data.ownerId },
            select: { status: true },
          });
          if (event && event.status !== EventStatus.DRAFT) {
            throw new ApiError(
              'Published event poster cannot be cleared',
              'BAD_USER_INPUT',
            );
          }
        }
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

  private async requireActiveCategory(id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, isActive: true },
      select: { id: true },
    });
    if (!category) {
      throw new ApiError('Active category not found', 'BAD_USER_INPUT');
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
          ...(version !== undefined && { version }),
          ...(toStatus === EventStatus.PUBLISHED && {
            AND: [
              { posterImageUrl: { not: null } },
              { posterImageUrl: { not: '' } },
            ],
          }),
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

import { Injectable } from '@nestjs/common';
import {
  EventSessionStatus,
  EventStatus,
  TicketTypeStatus,
} from '@prisma/client';
import { CreateEventInput } from '../presentation/graphql/inputs/create-event.input';
import { UpdateEventInput } from '../presentation/graphql/inputs/update-event.input';
import { UpdateEventStatusInput } from '../presentation/graphql/inputs/update-event-status.input';
import {
  CreateEventData,
  EventsRepository,
  PublishedEventFilter,
  PublishedEventPageRow,
  UpdateEventData,
} from '../infrastructure/events.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import {
  EventSessionFilter,
  EventsSessionRepository,
} from '../infrastructure/event-session.repository';
import { ApiError } from '../../../common/errors/api-error';
import { getPlace, getPlaces, validatePlace } from './location-catalog';

const allowedTransitions: Record<EventStatus, EventStatus[]> = {
  [EventStatus.DRAFT]: [EventStatus.PUBLISHED, EventStatus.CANCELLED],
  [EventStatus.PUBLISHED]: [EventStatus.CANCELLED, EventStatus.ARCHIVED],
  [EventStatus.CANCELLED]: [],
  [EventStatus.ARCHIVED]: [],
};

const DEFAULT_EVENT_PAGE_SIZE = 20;
const MAX_EVENT_PAGE_SIZE = 50;
const MAX_DISCOVERY_PAGE_SIZE = 20;

type EventDiscoveryFilter = Pick<
  PublishedEventFilter,
  'city' | 'countryCode' | 'placeId' | 'startsAtFrom' | 'startsAtTo'
>;

function normalizeLocationFilter(
  countryCode?: string | null,
  placeId?: string | null,
) {
  const country = countryCode?.trim().toUpperCase();
  if (countryCode != null && !country) {
    throw new ApiError('Unsupported country', 'BAD_USER_INPUT');
  }
  if (country) getPlaces(country);

  if (placeId != null) {
    const place = getPlace(placeId);
    if (!place) throw new ApiError('Unsupported place', 'BAD_USER_INPUT');
    validatePlace(placeId, country ?? place.countryCode);
  }

  return { countryCode: country, placeId: placeId ?? undefined };
}

function encodeEventCursor(id: string) {
  return Buffer.from(id).toString('base64url');
}

function decodeEventCursor(cursor: string) {
  const id = Buffer.from(cursor, 'base64url').toString();
  if (
    Buffer.from(id).toString('base64url') !== cursor ||
    !/^[0-9a-f]{24}$/i.test(id)
  ) {
    throw new ApiError('Invalid event cursor', 'BAD_USER_INPUT');
  }
  return id;
}

function encodeSessionCursor(id: string) {
  return Buffer.from(`session:${id}`).toString('base64url');
}

function decodeSessionCursor(cursor: string) {
  const value = Buffer.from(cursor, 'base64url').toString();
  const id = value.startsWith('session:') ? value.slice('session:'.length) : '';
  if (
    Buffer.from(value).toString('base64url') !== cursor ||
    !/^[0-9a-f]{24}$/i.test(id)
  ) {
    throw new ApiError('Invalid session cursor', 'BAD_USER_INPUT');
  }
  return id;
}

function getPageSize(first?: number) {
  const requestedSize = first ?? DEFAULT_EVENT_PAGE_SIZE;
  if (!Number.isInteger(requestedSize) || requestedSize < 1) {
    throw new ApiError('first must be a positive integer', 'BAD_USER_INPUT');
  }
  return Math.min(requestedSize, MAX_EVENT_PAGE_SIZE);
}

@Injectable()
export class EventService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly eventsSessionRepository: EventsSessionRepository,
    private readonly outbox: OutboxProcessor,
  ) {}

  findPublished(includeAvailabilitySummary = false) {
    return this.eventsRepository.findPublished(includeAvailabilitySummary);
  }

  async findPublishedPage(input: {
    first?: number;
    after?: string;
    filter?: PublishedEventFilter;
    includeSessions?: boolean;
    includeSummary?: boolean;
  }) {
    const pageSize = getPageSize(input.first);
    const now = new Date();

    const filter = input.filter ?? {};
    const categoryId = filter.categoryId?.trim();
    const q = filter.q?.trim();
    const city = filter.city?.trim();
    const location = normalizeLocationFilter(filter.countryCode, filter.placeId);
    if (
      filter.categoryId != null &&
      !/^[0-9a-f]{24}$/i.test(categoryId ?? '')
    ) {
      throw new ApiError(
        'categoryId must be a valid MongoDB ObjectId',
        'BAD_USER_INPUT',
      );
    }
    if (q && q.length > 100) {
      throw new ApiError('q must be at most 100 characters', 'BAD_USER_INPUT');
    }
    if (city && city.length > 100) {
      throw new ApiError(
        'city must be at most 100 characters',
        'BAD_USER_INPUT',
      );
    }
    if (
      filter.startsAtFrom &&
      filter.startsAtTo &&
      filter.startsAtFrom > filter.startsAtTo
    ) {
      throw new ApiError(
        'startsAtFrom must be before or equal to startsAtTo',
        'BAD_USER_INPUT',
      );
    }

    const rows = await this.eventsRepository.findPublishedPage({
      first: pageSize + 1,
      now,
      afterId: input.after != null ? decodeEventCursor(input.after) : undefined,
      includeSessions: input.includeSessions,
      includeSummary: input.includeSummary,
      filter: {
        categoryId: categoryId || undefined,
        q: q || undefined,
        city: city || undefined,
        ...location,
        startsAtFrom: filter.startsAtFrom,
        startsAtTo: filter.startsAtTo,
        upcomingOnly: filter.upcomingOnly ?? false,
      },
    });
    const hasNextPage = rows.length > pageSize;
    const nodes = rows
      .slice(0, pageSize)
      .map((event) =>
        this.toDiscoveryEvent(event, now, { ...filter, ...location, city }),
      );

    return {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor: nodes.length ? encodeEventCursor(nodes.at(-1)!.id) : null,
      },
    };
  }

  async findFeaturedEvents(input: { first?: number; city?: string }) {
    const first = input.first ?? 10;
    if (
      !Number.isInteger(first) ||
      first < 1 ||
      first > MAX_DISCOVERY_PAGE_SIZE
    ) {
      throw new ApiError('first must be between 1 and 20', 'BAD_USER_INPUT');
    }
    const city = input.city?.trim();
    if (city && city.length > 100) {
      throw new ApiError('city must be at most 100 characters', 'BAD_USER_INPUT');
    }

    const now = new Date();
    const events = await this.eventsRepository.findFeaturedEvents({
      first,
      now,
      city: city || undefined,
    });
    return events.map((event) => this.toDiscoveryEvent(event, now, { city }));
  }

  async findPublicUpcomingEventsByIds(eventIds: string[], city?: string) {
    const now = new Date();
    const events = await this.eventsRepository.findPublicUpcomingEventsByIds({
      eventIds,
      now,
      city,
    });
    return events.map((event) => this.toDiscoveryEvent(event, now, { city }));
  }

  setEventFeatured(eventId: string, featuredOrder: number | null) {
    if (!/^[0-9a-f]{24}$/i.test(eventId)) {
      throw new ApiError('Event not found', 'BAD_USER_INPUT');
    }
    if (
      featuredOrder !== null &&
      (!Number.isInteger(featuredOrder) || featuredOrder < 0)
    ) {
      throw new ApiError(
        'featuredOrder must be a non-negative integer or null',
        'BAD_USER_INPUT',
      );
    }
    return this.eventsRepository.setFeaturedOrder(eventId, featuredOrder);
  }

  private toDiscoveryEvent(
    event: PublishedEventPageRow,
    now: Date,
    filter: EventDiscoveryFilter,
  ) {
    const nextSession = (event.sessions ?? [])
      .filter((session) => {
        if (
          session.status !== EventSessionStatus.SCHEDULED ||
          !session.startsAt ||
          session.startsAt <= now
        ) {
          return false;
        }
        if (
          filter.city &&
          !session.city?.toLowerCase().includes(filter.city.toLowerCase())
        ) {
          return false;
        }
        if (filter.countryCode && session.countryCode !== filter.countryCode) {
          return false;
        }
        if (filter.placeId && session.placeId !== filter.placeId) {
          return false;
        }
        if (filter.startsAtFrom && session.startsAt < filter.startsAtFrom) {
          return false;
        }
        if (filter.startsAtTo && session.startsAt > filter.startsAtTo) {
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          a.startsAt!.getTime() - b.startsAt!.getTime() ||
          a.id.localeCompare(b.id),
      )[0];
    const prices = (nextSession?.ticketTypes ?? [])
      .filter(
        (ticketType) =>
          ticketType.status === TicketTypeStatus.ACTIVE &&
          (ticketType.salesStartAt == null || ticketType.salesStartAt <= now) &&
          Number.isInteger(ticketType.price) &&
          ticketType.price >= 0,
      )
      .map((ticketType) => ticketType.price);

    return {
      ...event,
      nextSession: nextSession ?? null,
      priceFrom: prices.length ? Math.min(...prices) : null,
      currency: nextSession?.currency ?? null,
      availability: null,
    };
  }

  async findSessionsPage(
    input: {
      eventId: string;
      first?: number;
      after?: string;
      filter?: EventSessionFilter;
    },
    viewer?: { sub: string; role?: string },
  ) {
    if (!/^[0-9a-f]{24}$/i.test(input.eventId)) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const event = await this.eventsRepository.findVisibilityById(input.eventId);
    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const canManage = event.ownerId === viewer?.sub || viewer?.role === 'ADMIN';
    if (event.status !== EventStatus.PUBLISHED && !canManage) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const pageSize = getPageSize(input.first);
    const filter = input.filter ?? {};
    const city = filter.city?.trim();
    const location = normalizeLocationFilter(filter.countryCode, filter.placeId);
    if (city && city.length > 100) {
      throw new ApiError(
        'city must be at most 100 characters',
        'BAD_USER_INPUT',
      );
    }
    if (
      filter.startsAtFrom &&
      filter.startsAtTo &&
      filter.startsAtFrom > filter.startsAtTo
    ) {
      throw new ApiError(
        'startsAtFrom must be before or equal to startsAtTo',
        'BAD_USER_INPUT',
      );
    }

    const rows = await this.eventsSessionRepository.findPage({
      eventId: input.eventId,
      first: pageSize + 1,
      afterId:
        input.after != null ? decodeSessionCursor(input.after) : undefined,
      includeDrafts: canManage,
      filter: {
        ...filter,
        ...location,
        city: city || undefined,
      },
    });
    const hasNextPage = rows.length > pageSize;
    const nodes = rows.slice(0, pageSize);

    return {
      nodes,
      pageInfo: {
        hasNextPage,
        endCursor: nodes.length ? encodeSessionCursor(nodes.at(-1)!.id) : null,
      },
    };
  }

  findByOwner(ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }
    return this.eventsRepository.findByOwner(ownerId);
  }

  async findById(id: string, viewer?: { sub: string; role?: string }) {
    if (!/^[0-9a-f]{24}$/i.test(id)) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const event = await this.eventsRepository.findById(id);
    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    const canManage = event.ownerId === viewer?.sub || viewer?.role === 'ADMIN';
    if (event.status !== EventStatus.PUBLISHED && !canManage) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    // Session DRAFT là bản nháp nội bộ — chỉ owner/admin nhìn thấy.
    if (!canManage && event.sessions) {
      event.sessions = event.sessions.filter(
        (session) => session.status !== EventSessionStatus.DRAFT,
      ).map((session) => ({
        ...session,
        ticketTypes: session.ticketTypes?.filter(
          (ticketType) => ticketType.status !== TicketTypeStatus.INACTIVE,
        ),
      }));
    }

    return event;
  }

  async getTicketSnapshot(eventId: string, sessionId: string) {
    if (
      !/^[0-9a-f]{24}$/i.test(eventId) ||
      !/^[0-9a-f]{24}$/i.test(sessionId)
    ) {
      throw new ApiError('Ticket event data not found', 'NOT_FOUND');
    }
    const event = await this.eventsRepository.findById(eventId);
    const session = event?.sessions.find((item) => item.id === sessionId);
    if (!event || !session) {
      throw new ApiError('Ticket event data not found', 'NOT_FOUND');
    }
    return {
      eventTitle: event.title,
      eventStatus: event.status,
      coverImageUrl: event.coverImageUrl ?? null,
      posterImageUrl: event.posterImageUrl ?? null,
      venueName: session.venueName ?? null,
      venueAddress: session.venueAddress ?? null,
      startsAt: session.startsAt ?? null,
      endsAt: session.endsAt ?? null,
      timezone: session.timezone,
      sessionVersion: session.version ?? 1,
      sessionStatus: session.status,
    };
  }

  create(input: CreateEventInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const data: CreateEventData = {
      title: input.title,
      slug: input.slug,
      summary: input.summary,
      organizerDisplayName: input.organizerDisplayName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      coverImageUrl: input.coverImageUrl,
      posterImageUrl: input.posterImageUrl,
      categoryId: input.categoryId,
      ownerId,
    };

    return this.eventsRepository.create(data);
  }

  update(input: UpdateEventInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const hasChanges = [
      input.title,
      input.slug,
      input.summary,
      input.organizerDisplayName,
      input.contactEmail,
      input.contactPhone,
      input.coverImageUrl,
      input.posterImageUrl,
      input.categoryId,
    ].some((value) => value !== undefined);

    if (!hasChanges) {
      throw new ApiError(
        'At least one field must be updated',
        'BAD_USER_INPUT',
      );
    }

    const data: UpdateEventData = {
      id: input.id,
      title: input.title,
      slug: input.slug,
      summary: input.summary,
      organizerDisplayName: input.organizerDisplayName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      coverImageUrl: input.coverImageUrl,
      posterImageUrl: input.posterImageUrl,
      categoryId: input.categoryId,
      ownerId,
    };

    return this.eventsRepository.update(data);
  }

  async updateStatus(input: UpdateEventStatusInput, ownerId: string) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const event = await this.eventsRepository.findByIdAndOwner(
      input.id,
      ownerId,
    );

    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    if (event.status === input.status) {
      throw new ApiError('Event is already in this status', 'BAD_USER_INPUT');
    }

    if (
      input.status === EventStatus.PUBLISHED &&
      !event.posterImageUrl?.trim()
    ) {
      throw new ApiError(
        'Poster is required before publishing',
        'BAD_USER_INPUT',
      );
    }

    if (
      input.status === EventStatus.CANCELLED &&
      !input.cancellationReason?.trim()
    ) {
      throw new ApiError('Cancellation reason is required', 'BAD_USER_INPUT');
    }

    const allowed = allowedTransitions[event.status];
    if (!allowed.includes(input.status)) {
      throw new ApiError(
        `Cannot transition from ${event.status} to ${input.status}`,
        'BAD_USER_INPUT',
      );
    }

    /* ARCHIVED không cascade session — nếu archive khi còn session đang
       mở thì inventory không nhận được session.status.changed, vé vẫn
       bán được. Chặn: archive chỉ là housekeeping sau khi mọi session đã
       COMPLETED/CANCELLED. */
    if (input.status === EventStatus.ARCHIVED) {
      const liveSessions = await this.eventsSessionRepository.countLiveSessions(
        input.id,
      );
      if (liveSessions > 0) {
        throw new ApiError(
          'Cannot archive an event with draft or scheduled sessions — complete or cancel them first',
          'BAD_USER_INPUT',
          { liveSessions },
        );
      }
    }

    const updated = await this.eventsRepository.updateStatus(
      input.id,
      ownerId,
      event.status,
      input.status,
      input.cancellationReason,
      event.version,
    );
    if (
      input.status === EventStatus.CANCELLED ||
      input.status === EventStatus.PUBLISHED
    ) {
      this.outbox.wake();
    }
    return updated;
  }

  /**
   * Organizer chủ động hoàn 1 booking. Ownership check qua
   * findByIdAndOwner — chỉ owner mới phát được lệnh. Thực thi async:
   * booking-service consume 'booking.refund.requested', verify
   * booking.eventId khớp event_id rồi mới refund.
   */
  async requestBookingRefund(
    input: { eventId: string; bookingId: string; reason?: string },
    ownerId: string,
  ) {
    if (!ownerId?.trim()) {
      throw new ApiError('Authentication is required', 'UNAUTHENTICATED');
    }

    const event = await this.eventsRepository.findByIdAndOwner(
      input.eventId,
      ownerId,
    );
    if (!event) {
      throw new ApiError('Event not found', 'NOT_FOUND');
    }

    await this.eventsRepository.emitRefundRequest({
      eventId: event.id,
      aggregateVersion: event.version,
      bookingId: input.bookingId,
      reason: input.reason,
      requestedBy: ownerId,
    });
    this.outbox.wake();
    return true;
  }
}

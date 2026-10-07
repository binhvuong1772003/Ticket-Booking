import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/errors/api-error';
import { BookingTrendingClient } from '../infrastructure/booking-trending.client';
import { EventService } from './event.service';

type PublicUpcomingEvent = Awaited<
  ReturnType<EventService['findPublicUpcomingEventsByIds']>
>[number];

const MAX_TRENDING_PAGE_SIZE = 20;
const BOOKING_SALES_BATCH_SIZE = 100;
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRENDING_BUCKET_MS = 20_000;

@Injectable()
export class TrendingService {
  constructor(
    private readonly bookingTrendingClient: BookingTrendingClient,
    private readonly eventService: EventService,
  ) {}

  async findTrendingEvents(input: { first?: number; city?: string }) {
    const first = input.first ?? 10;
    if (
      !Number.isInteger(first) ||
      first < 1 ||
      first > MAX_TRENDING_PAGE_SIZE
    ) {
      throw new ApiError('first must be between 1 and 20', 'BAD_USER_INPUT');
    }
    const city = input.city?.trim();
    if (city && city.length > 100) {
      throw new ApiError(
        'city must be at most 100 characters',
        'BAD_USER_INPUT',
      );
    }

    const since = new Date(
      Math.floor((Date.now() - TRENDING_WINDOW_MS) / TRENDING_BUCKET_MS) *
        TRENDING_BUCKET_MS,
    );
    const result: { rank: number; event: PublicUpcomingEvent }[] = [];
    const rankedIds = new Set<string>();
    let after: string | undefined;

    while (result.length < first) {
      const page = await this.bookingTrendingClient.getSalesPage({
        since,
        first: BOOKING_SALES_BATCH_SIZE,
        after,
      });
      const eventIds = page.nodes.map((node) => node.eventId);
      const events = eventIds.length
        ? await this.eventService.findPublicUpcomingEventsByIds(
            eventIds,
            city || undefined,
          )
        : [];
      const eventsById = new Map(events.map((event) => [event.id, event]));
      for (const { eventId } of page.nodes) {
        const event = eventsById.get(eventId);
        if (!event || rankedIds.has(eventId)) continue;
        rankedIds.add(eventId);
        result.push({ rank: result.length + 1, event });
        if (result.length === first) break;
      }

      if (result.length === first || !page.pageInfo.hasNextPage) break;
      if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) {
        throw new Error('booking-service returned an invalid trending cursor');
      }
      after = page.pageInfo.endCursor;
    }
    return result;
  }
}

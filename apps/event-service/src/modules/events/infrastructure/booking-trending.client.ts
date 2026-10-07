import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';

export type BookingTrendingPage = {
  nodes: { eventId: string; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

@Injectable()
export class BookingTrendingClient {
  private readonly endpoint =
    process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql';
  private readonly redis = new Redis(
    `redis://${process.env.REDIS_HOST ?? 'localhost'}:${process.env.REDIS_PORT ?? '6380'}`,
    {
      connectTimeout: 500,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    },
  );

  constructor() {
    this.redis.on('error', () => undefined);
  }

  async getSalesPage(input: { since: Date; first: number; after?: string }) {
    const token = process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    if (!token) {
      throw new Error('Booking service authentication is not configured');
    }
    const cursorHash = createHash('sha256')
      .update(input.after ?? '')
      .digest('hex')
      .slice(0, 16);
    const key = `event:trending-sales:v1:${input.since.toISOString()}:${input.first}:${cursorHash}`;
    if (this.redis.status === 'ready') {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          const page = JSON.parse(cached) as BookingTrendingPage;
          if (this.isValidPage(page)) return page;
        }
      } catch {
        // Cache failures fall through to booking-service.
      }
    }
    const page = await this.fetchSalesPage(input, token);
    if (this.redis.status === 'ready') {
      try {
        await this.redis.set(key, JSON.stringify(page), 'EX', 20);
      } catch {
        // Cache failures do not affect the booking-service response.
      }
    }
    return page;
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  private async fetchSalesPage(
    input: { since: Date; first: number; after?: string },
    token: string,
  ) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-booking-service-token': token,
      },
      body: JSON.stringify({
        query: `query InternalTrendingSales($since: DateTime!, $first: Int!, $after: String) {
          internalTrendingSales(since: $since, first: $first, after: $after) {
            nodes { eventId cursor }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: {
          since: input.since.toISOString(),
          first: input.first,
          after: input.after,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`booking-service responded ${response.status}`);

    const body = (await response.json()) as {
      data?: { internalTrendingSales?: BookingTrendingPage };
      errors?: unknown[];
    };
    const page = body.data?.internalTrendingSales;
    if (!this.isValidPage(page) || body.errors?.length) {
      throw new Error('booking-service trending lookup failed');
    }
    return page;
  }

  private isValidPage(
    page: BookingTrendingPage | undefined,
  ): page is BookingTrendingPage {
    return (
      !!page &&
      Array.isArray(page.nodes) &&
      typeof page.pageInfo?.hasNextPage === 'boolean' &&
      (page.pageInfo.endCursor === null ||
        typeof page.pageInfo.endCursor === 'string') &&
      page.nodes.every(
        (node) =>
          typeof node.eventId === 'string' && typeof node.cursor === 'string',
      )
    );
  }
}

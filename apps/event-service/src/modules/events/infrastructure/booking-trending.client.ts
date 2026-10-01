import { Injectable } from '@nestjs/common';

export type BookingTrendingPage = {
  nodes: { eventId: string; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

@Injectable()
export class BookingTrendingClient {
  private readonly endpoint =
    process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql';

  async getSalesPage(input: { since: Date; first: number; after?: string }) {
    const token = process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    if (!token) throw new Error('Booking service authentication is not configured');

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
    if (!response.ok) throw new Error(`booking-service responded ${response.status}`);

    const body = (await response.json()) as {
      data?: { internalTrendingSales?: BookingTrendingPage };
      errors?: unknown[];
    };
    const page = body.data?.internalTrendingSales;
    if (
      body.errors?.length ||
      !page ||
      !Array.isArray(page.nodes) ||
      typeof page.pageInfo?.hasNextPage !== 'boolean' ||
      (page.pageInfo.endCursor !== null &&
        typeof page.pageInfo.endCursor !== 'string') ||
      page.nodes.some(
        (node) =>
          typeof node.eventId !== 'string' || typeof node.cursor !== 'string',
      )
    ) {
      throw new Error('booking-service trending lookup failed');
    }
    return page;
  }
}

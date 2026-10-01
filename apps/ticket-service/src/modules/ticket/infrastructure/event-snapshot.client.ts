import { Injectable } from '@nestjs/common';

export type EventTicketSnapshot = {
  eventTitle: string;
  eventStatus: string;
  posterImageUrl: string | null;
  coverImageUrl: string | null;
  venueName: string | null;
  venueAddress: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  sessionVersion: number;
  sessionStatus: string;
};

@Injectable()
export class EventSnapshotClient {
  private readonly endpoint =
    process.env.EVENT_SERVICE_URL ?? 'http://localhost:4003/graphql';

  async getTicketSnapshot(eventId: string, sessionId: string) {
    const token = process.env.EVENT_INTERNAL_SERVICE_TOKEN;
    if (!token) {
      throw new Error('Event service authentication is not configured');
    }
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-event-service-token': token,
      },
      body: JSON.stringify({
        query: `query TicketSnapshot($eventId: ID!, $sessionId: ID!) {
          ticketSnapshot(eventId: $eventId, sessionId: $sessionId) {
            eventTitle eventStatus posterImageUrl coverImageUrl venueName venueAddress startsAt endsAt timezone sessionVersion sessionStatus
          }
        }`,
        variables: { eventId, sessionId },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`event-service responded ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: { ticketSnapshot?: Record<string, unknown> };
      errors?: unknown[];
    };
    const snapshot = body.data?.ticketSnapshot;
    if (body.errors?.length || !snapshot || typeof snapshot.eventTitle !== 'string') {
      throw new Error('event-service ticket snapshot lookup failed');
    }
    const toDate = (value: unknown) => {
      if (value == null) return null;
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new Error('event-service returned an invalid ticket date');
      }
      return date;
    };
    if (
      typeof snapshot.timezone !== 'string' ||
      !Number.isInteger(snapshot.sessionVersion) ||
      typeof snapshot.eventStatus !== 'string' ||
      typeof snapshot.sessionStatus !== 'string'
    ) {
      throw new Error('event-service returned an invalid ticket snapshot');
    }

    return {
      eventTitle: snapshot.eventTitle,
      eventStatus: snapshot.eventStatus,
      posterImageUrl:
        typeof snapshot.posterImageUrl === 'string'
          ? snapshot.posterImageUrl
          : null,
      coverImageUrl:
        typeof snapshot.coverImageUrl === 'string'
          ? snapshot.coverImageUrl
          : null,
      venueName: typeof snapshot.venueName === 'string' ? snapshot.venueName : null,
      venueAddress:
        typeof snapshot.venueAddress === 'string' ? snapshot.venueAddress : null,
      startsAt: toDate(snapshot.startsAt),
      endsAt: toDate(snapshot.endsAt),
      timezone: snapshot.timezone,
      sessionVersion: snapshot.sessionVersion as number,
      sessionStatus: snapshot.sessionStatus,
    } satisfies EventTicketSnapshot;
  }
}

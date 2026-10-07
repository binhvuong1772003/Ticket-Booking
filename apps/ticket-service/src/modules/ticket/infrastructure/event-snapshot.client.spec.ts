import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventSnapshotClient } from './event-snapshot.client';

describe('EventSnapshotClient poster snapshot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('requests and maps posterImageUrl while keeping it nullable for older responses', async () => {
    vi.stubEnv('EVENT_INTERNAL_SERVICE_TOKEN', 'event-service-test-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        ticketSnapshot: {
          eventTitle: 'Saigon Live', eventStatus: 'PUBLISHED',
          posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
          coverImageUrl: null, venueName: null, venueAddress: null,
          startsAt: '2026-10-01T12:00:00.000Z', endsAt: null,
          timezone: 'Asia/Ho_Chi_Minh', sessionVersion: 1,
          sessionStatus: 'SCHEDULED',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await new EventSnapshotClient().getTicketSnapshot('event-1', 'session-1');

    expect(snapshot.posterImageUrl).toBe(
      'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toContain('posterImageUrl');
  });

  it('maps a missing poster field to null', async () => {
    vi.stubEnv('EVENT_INTERNAL_SERVICE_TOKEN', 'event-service-test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        ticketSnapshot: {
          eventTitle: 'Legacy event', eventStatus: 'PUBLISHED', coverImageUrl: null,
          venueName: null, venueAddress: null, startsAt: null, endsAt: null,
          timezone: 'UTC', sessionVersion: 1, sessionStatus: 'SCHEDULED',
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const snapshot = await new EventSnapshotClient().getTicketSnapshot('event-1', 'session-1');
    expect(snapshot.posterImageUrl).toBeNull();
  });
});

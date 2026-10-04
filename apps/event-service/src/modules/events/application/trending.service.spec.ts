import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrendingService } from './trending.service';
import { EventService } from './event.service';
import { BookingTrendingClient } from '../infrastructure/booking-trending.client';

describe('TrendingService', () => {
  const getSalesPage = vi.fn();
  const findPublicUpcomingEventsByIds = vi.fn();
  let service: TrendingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TrendingService(
      { getSalesPage } as unknown as BookingTrendingClient,
      { findPublicUpcomingEventsByIds } as unknown as EventService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refills past non-public events and assigns consecutive public ranks', async () => {
    getSalesPage
      .mockResolvedValueOnce({
        nodes: [
          { eventId: 'private-event', cursor: 'cursor-1' },
          { eventId: 'public-event-2', cursor: 'cursor-2' },
        ],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
      })
      .mockResolvedValueOnce({
        nodes: [{ eventId: 'public-event-3', cursor: 'cursor-3' }],
        pageInfo: { hasNextPage: false, endCursor: 'cursor-3' },
      });
    findPublicUpcomingEventsByIds
      .mockResolvedValueOnce([{ id: 'public-event-2', title: 'Second' }])
      .mockResolvedValueOnce([{ id: 'public-event-3', title: 'Third' }]);

    const result = await service.findTrendingEvents({
      first: 2,
      city: 'Hanoi',
    });

    expect(getSalesPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        first: expect.any(Number),
        after: undefined,
        since: expect.any(Date),
      }),
    );
    expect(getSalesPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        after: 'cursor-2',
        since: getSalesPage.mock.calls[0][0].since,
      }),
    );
    expect(findPublicUpcomingEventsByIds).toHaveBeenNthCalledWith(
      1,
      ['private-event', 'public-event-2'],
      'Hanoi',
    );
    expect(result).toEqual([
      { rank: 1, event: { id: 'public-event-2', title: 'Second' } },
      { rank: 2, event: { id: 'public-event-3', title: 'Third' } },
    ]);
  });

  it('uses one 20-second since bucket per request, shared by every page', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now + 19_999);
    getSalesPage
      .mockResolvedValueOnce({
        nodes: [{ eventId: 'hidden', cursor: 'cursor-1' }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        nodes: [{ eventId: 'visible', cursor: 'cursor-2' }],
        pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
      });
    findPublicUpcomingEventsByIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'visible' }]);

    await service.findTrendingEvents({ first: 1 });

    const expectedSince = new Date(
      Math.floor((now + 19_999 - 7 * 24 * 60 * 60 * 1000) / 20_000) * 20_000,
    );
    expect(getSalesPage.mock.calls.map(([args]) => args.since)).toEqual([
      expectedSince,
      expectedSince,
    ]);
    expect(getSalesPage.mock.calls.map(([args]) => args.after)).toEqual([
      undefined,
      'cursor-1',
    ]);
  });

  it('shares since within a bucket and advances it in the next bucket', async () => {
    const now = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, 'now');
    const page = {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    getSalesPage.mockResolvedValue(page);

    dateNow.mockReturnValue(now + 1);
    await service.findTrendingEvents({});
    dateNow.mockReturnValue(now + 19_999);
    await service.findTrendingEvents({});
    dateNow.mockReturnValue(now + 20_000);
    await service.findTrendingEvents({});

    const since = getSalesPage.mock.calls.map(([args]) => args.since.getTime());
    expect(since[0]).toBe(since[1]);
    expect(since[2] - since[1]).toBe(20_000);
  });

  it('rechecks current public events on every request using the sales page', async () => {
    const page = {
      nodes: [{ eventId: 'event-1', cursor: 'cursor-1' }],
      pageInfo: { hasNextPage: false, endCursor: 'cursor-1' },
    };
    getSalesPage.mockResolvedValue(page);
    findPublicUpcomingEventsByIds
      .mockResolvedValueOnce([{ id: 'event-1', title: 'Still public' }])
      .mockResolvedValueOnce([]);

    await expect(service.findTrendingEvents({})).resolves.toHaveLength(1);
    await expect(service.findTrendingEvents({})).resolves.toEqual([]);

    expect(getSalesPage).toHaveBeenCalledTimes(2);
    expect(findPublicUpcomingEventsByIds).toHaveBeenCalledTimes(2);
  });

  it('returns no result when the source has no sales and propagates source failures', async () => {
    getSalesPage.mockResolvedValueOnce({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    await expect(service.findTrendingEvents({})).resolves.toEqual([]);

    getSalesPage.mockRejectedValueOnce(new Error('booking unavailable'));
    await expect(service.findTrendingEvents({})).rejects.toThrow(
      'booking unavailable',
    );
  });

  it('rejects invalid public page sizes and city filters', async () => {
    await expect(
      service.findTrendingEvents({ first: 0 }),
    ).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await expect(
      service.findTrendingEvents({ city: 'x'.repeat(101) }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(getSalesPage).not.toHaveBeenCalled();
  });
});

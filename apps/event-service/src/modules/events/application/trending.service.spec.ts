import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('refills past non-public events and assigns consecutive public ranks', async () => {
    getSalesPage.mockResolvedValueOnce({
      nodes: [
        { eventId: 'private-event', cursor: 'cursor-1' },
        { eventId: 'public-event-2', cursor: 'cursor-2' },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
    }).mockResolvedValueOnce({
      nodes: [{ eventId: 'public-event-3', cursor: 'cursor-3' }],
      pageInfo: { hasNextPage: false, endCursor: 'cursor-3' },
    });
    findPublicUpcomingEventsByIds
      .mockResolvedValueOnce([{ id: 'public-event-2', title: 'Second' }])
      .mockResolvedValueOnce([{ id: 'public-event-3', title: 'Third' }]);

    const result = await service.findTrendingEvents({ first: 2, city: 'Hanoi' });

    expect(getSalesPage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      first: expect.any(Number),
      after: undefined,
      since: expect.any(Date),
    }));
    expect(getSalesPage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      after: 'cursor-2',
    }));
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
    await expect(service.findTrendingEvents({ first: 0 })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await expect(
      service.findTrendingEvents({ city: 'x'.repeat(101) }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(getSalesPage).not.toHaveBeenCalled();
  });
});

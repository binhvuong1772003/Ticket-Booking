import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  quit: vi.fn(),
  disconnect: vi.fn(),
  options: undefined as unknown,
  status: 'ready',
}));

vi.mock('ioredis', () => ({
  default: class {
    constructor(_url: string, options: unknown) {
      redis.options = options;
    }
    get = redis.get;
    set = redis.set;
    get status() {
      return redis.status;
    }
    quit = redis.quit;
    disconnect = redis.disconnect;
    on() {
      return this;
    }
  },
}));

import { BookingTrendingClient } from './booking-trending.client';

const page = {
  nodes: [{ eventId: 'event-1', cursor: 'cursor-1' }],
  pageInfo: { hasNextPage: false, endCursor: 'cursor-1' },
};

describe('BookingTrendingClient cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    redis.status = 'ready';
    process.env.BOOKING_INTERNAL_SERVICE_TOKEN = 'test-token';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { internalTrendingSales: page } }),
      }),
    );
  });

  it('caches validated pages for 20 seconds and reuses them', async () => {
    const client = new BookingTrendingClient();
    const input = {
      since: new Date('2026-10-01T00:00:00.000Z'),
      first: 10,
      after: 'cursor',
    };
    await client.getSalesPage(input);
    redis.get.mockResolvedValueOnce(JSON.stringify(page));
    await client.getSalesPage(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('event:trending-sales:v1:'),
      JSON.stringify(page),
      'EX',
      20,
    );
    expect(redis.options).not.toHaveProperty('lazyConnect', true);
    expect(redis.options).toMatchObject({
      enableOfflineQueue: false,
      connectTimeout: 500,
      commandTimeout: 500,
    });
  });

  it('continues to booking when Redis fails and does not mask booking errors', async () => {
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      new BookingTrendingClient().getSalesPage({
        since: new Date(0),
        first: 1,
      }),
    ).resolves.toEqual(page);

    redis.set.mockRejectedValueOnce(new Error('redis write down'));
    await expect(
      new BookingTrendingClient().getSalesPage({
        since: new Date(0),
        first: 1,
      }),
    ).resolves.toEqual(page);

    vi.mocked(fetch).mockRejectedValueOnce(new Error('booking down'));
    await expect(
      new BookingTrendingClient().getSalesPage({
        since: new Date(0),
        first: 1,
      }),
    ).rejects.toThrow('booking down');
  });

  it('does not cache invalid booking pages and closes Redis at shutdown', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { internalTrendingSales: { nodes: [], pageInfo: {} } },
      }),
    } as Response);
    const client = new BookingTrendingClient();
    await expect(
      client.getSalesPage({ since: new Date(0), first: 1 }),
    ).rejects.toThrow('booking-service trending lookup failed');
    expect(redis.set).not.toHaveBeenCalled();
    await client.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalledOnce();
  });

  it('checks booking authentication before serving a cached page', async () => {
    delete process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    redis.get.mockResolvedValueOnce(JSON.stringify(page));
    await expect(
      new BookingTrendingClient().getSalesPage({
        since: new Date(0),
        first: 1,
      }),
    ).rejects.toThrow('Booking service authentication is not configured');
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('uses distinct keys for since buckets, page sizes, and cursors', async () => {
    const client = new BookingTrendingClient();
    await client.getSalesPage({
      since: new Date(0),
      first: 1,
      after: 'cursor-a',
    });
    await client.getSalesPage({
      since: new Date(1),
      first: 1,
      after: 'cursor-a',
    });
    await client.getSalesPage({
      since: new Date(0),
      first: 2,
      after: 'cursor-a',
    });
    await client.getSalesPage({
      since: new Date(0),
      first: 1,
      after: 'cursor-b',
    });
    const keys = redis.get.mock.calls.map(([key]) => key as string);
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((key) => !key.includes('cursor-'))).toBe(true);
  });

  it('skips Redis while connecting and resumes cache reads once ready', async () => {
    const client = new BookingTrendingClient();
    redis.status = 'connecting';
    redis.get.mockResolvedValueOnce(JSON.stringify(page));
    await expect(
      client.getSalesPage({ since: new Date(0), first: 1 }),
    ).resolves.toEqual(page);
    expect(redis.get).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();

    redis.status = 'ready';
    redis.get.mockResolvedValueOnce(JSON.stringify(page));
    await expect(
      client.getSalesPage({ since: new Date(0), first: 1 }),
    ).resolves.toEqual(page);
    expect(redis.get).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

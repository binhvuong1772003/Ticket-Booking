import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { EventsRepository } from './events.repository';
import { EventStatus } from '@prisma/client';

describe('EventsRepository.findPublishedPage discovery filters', () => {
  const findMany = vi.fn();
  const updateMany = vi.fn();
  const findUniqueOrThrow = vi.fn();
  let repository: EventsRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({ id: '64b64c0000000000000000e1' });
    repository = new EventsRepository({
      event: { findMany, updateMany, findUniqueOrThrow },
    } as unknown as PrismaService);
  });

  it('uses the same future scheduled-session predicate for selection and event matching', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const startsAtFrom = new Date('2026-10-01T00:00:00.000Z');
    const startsAtTo = new Date('2026-10-04T00:00:00.000Z');

    await repository.findPublishedPage({
      first: 11,
      now,
      includeSummary: true,
      filter: {
        upcomingOnly: true,
        categoryId: '64b64c0000000000000000e1',
        city: 'Hanoi',
        startsAtFrom,
        startsAtTo,
      },
    });

    const args = findMany.mock.calls[0][0];
    const expectedSessionWhere = {
      status: 'SCHEDULED',
      startsAt: { gt: now, gte: startsAtFrom, lte: startsAtTo },
      city: { contains: 'Hanoi', mode: 'insensitive' },
    };
    expect(args.where).toMatchObject({
      status: 'PUBLISHED',
      categoryId: '64b64c0000000000000000e1',
      category: { is: { isActive: true } },
      sessions: { some: expectedSessionWhere },
    });
    expect(args.include.sessions.where).toMatchObject(expectedSessionWhere);
    expect(args.include.sessions.include.ticketTypes.where.status).toMatchObject(
      { not: 'INACTIVE' },
    );
  });

  it('matches and includes the same catalog location session for discovery', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    await repository.findPublishedPage({
      first: 11,
      now,
      includeSummary: true,
      filter: {
        categoryId: '64b64c0000000000000000e1',
        q: 'concert',
        countryCode: 'VN',
        placeId: 'VN-HOCHIMINH',
        startsAtFrom: new Date('2026-10-01T00:00:00.000Z'),
        upcomingOnly: false,
      },
    });

    const args = findMany.mock.calls[0][0];
    const where = args.where.sessions.some;
    expect(where).toMatchObject({
      status: 'SCHEDULED',
      countryCode: 'VN',
      placeId: 'VN-HOCHIMINH',
      startsAt: { gt: now, gte: new Date('2026-10-01T00:00:00.000Z') },
    });
    expect(args.include.sessions.where).toEqual(where);
    expect(args.where.categoryId).toBe('64b64c0000000000000000e1');
    expect(args.where.OR[0].title.contains).toBe('concert');
  });

  it('does not add the upcoming predicate to existing event pages by default', async () => {
    await repository.findPublishedPage({ first: 11, filter: {} });

    const args = findMany.mock.calls[0][0];
    expect(args.where.status).toBe('PUBLISHED');
    expect(args.where.sessions).toBeUndefined();
  });

  it('filters featured candidates before applying stable featured order and limit', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');

    await repository.findFeaturedEvents({ first: 5, now, city: 'Hanoi' });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      status: 'PUBLISHED',
      featuredOrder: { not: null },
      sessions: {
        some: {
          status: 'SCHEDULED',
          startsAt: { gt: now },
          city: { contains: 'Hanoi', mode: 'insensitive' },
        },
      },
    });
    expect(args.where.posterImageUrl).toBeUndefined();
    expect(args.orderBy).toEqual([{ featuredOrder: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(5);
    expect(args.include.sessions).toMatchObject({
      where: args.where.sessions.some,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 1,
    });
  });

  it('persists an explicit featured order and supports clearing it', async () => {
    await repository.setFeaturedOrder('64b64c0000000000000000e1', null);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: '64b64c0000000000000000e1' },
      data: { featuredOrder: null },
    });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: '64b64c0000000000000000e1' },
    });
  });

  it('filters trending candidates to published events with a matching upcoming city session', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    await repository.findPublicUpcomingEventsByIds({
      eventIds: ['64b64c0000000000000000e1', '64b64c0000000000000000e2'],
      now,
      city: 'Hanoi',
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      id: { in: ['64b64c0000000000000000e1', '64b64c0000000000000000e2'] },
      status: 'PUBLISHED',
      sessions: {
        some: {
          status: 'SCHEDULED',
          startsAt: { gt: now },
          city: { contains: 'Hanoi', mode: 'insensitive' },
        },
      },
    });
    expect(args.include.sessions).toMatchObject({
      take: 1,
      include: { ticketTypes: { where: { status: { not: 'INACTIVE' } } } },
    });
  });
});

describe('EventsRepository.findPublished availability summary', () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const repository = new EventsRepository({
    event: { findMany },
  } as unknown as PrismaService);

  it('includes non-draft sessions and public ticket types when requested', async () => {
    await repository.findPublished(true);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          sessions: expect.objectContaining({
            where: { status: { not: 'DRAFT' } },
            include: {
              ticketTypes: { where: { status: { not: 'INACTIVE' } } },
            },
          }),
        },
      }),
    );
  });

  it('does not include sessions for the existing lightweight query', async () => {
    await repository.findPublished();

    expect(findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ include: expect.anything() }),
    );
  });
});

describe('EventsRepository poster status guards', () => {
  it('only clears a poster while the event is still a draft', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirst = vi.fn().mockResolvedValue({ status: EventStatus.PUBLISHED });
    const repository = new EventsRepository({
      event: { updateMany, findFirst },
    } as unknown as PrismaService);

    await expect(repository.update({
      id: 'event', ownerId: 'owner', posterImageUrl: null,
    })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'event', ownerId: 'owner', status: EventStatus.DRAFT },
      data: expect.objectContaining({ posterImageUrl: null }),
    }));
  });

  it('requires a non-null and non-empty poster in the atomic publish update', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn((callback) => callback({
      event: { updateMany },
      outboxEvent: { create: vi.fn() },
      eventSession: {},
    }));
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: 'event' });
    const repository = new EventsRepository({
      $transaction: transaction,
      event: { findUniqueOrThrow },
    } as unknown as PrismaService);

    await repository.updateStatus(
      'event', 'owner', EventStatus.DRAFT, EventStatus.PUBLISHED, undefined, 2,
    );

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'event', ownerId: 'owner', status: EventStatus.DRAFT, version: 2,
        AND: [
          { posterImageUrl: { not: null } },
          { posterImageUrl: { not: '' } },
        ],
      },
    }));
  });
});

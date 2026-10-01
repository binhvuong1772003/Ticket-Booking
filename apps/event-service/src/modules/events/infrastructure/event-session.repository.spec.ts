import { describe, expect, it, vi } from 'vitest';
import { EventsSessionRepository } from './event-session.repository';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

describe('session currency propagation', () => {
  const makeRepo = (currentCurrency = 'USD') => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async () => [{ id: 'tt1' }, { id: 'tt2' }]);
    const createMany = vi.fn();
    const findUniqueOrThrow = vi.fn(async () => ({ id: 's1' }));
    const prisma = {
      eventSession: {
        findFirst: async () => ({
          id: 's1',
          currency: currentCurrency,
          event: { status: 'PUBLISHED' },
        }),
        updateMany,
        findUniqueOrThrow,
      },
      ticketType: { findMany },
      outboxEvent: { createMany },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    const repo = new EventsSessionRepository(
      prisma as unknown as PrismaService,
    );
    return { repo, createMany, updateMany };
  };

  it('emits ticket-type.updated per type when currency changes', async () => {
    const { repo, createMany } = makeRepo('USD');
    await repo.update({ id: 's1', ownerId: 'u1', currency: 'VND' });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          eventType: 'ticket-type.updated',
          payload: { ticketTypeId: 'tt1', sessionId: 's1', currency: 'VND' },
        }),
        expect.objectContaining({
          eventType: 'ticket-type.updated',
          payload: { ticketTypeId: 'tt2', sessionId: 's1', currency: 'VND' },
        }),
      ],
    });
  });

  it.each([{ currency: 'USD' }, {}])(
    'skips fan-out when currency is unchanged or absent: %j',
    async (fields) => {
      const { repo, createMany } = makeRepo('USD');
      await repo.update({ id: 's1', ownerId: 'u1', ...fields });
      expect(createMany).not.toHaveBeenCalled();
    },
  );
});

describe('EventsSessionRepository.findPage visibility', () => {
  it('filters inactive ticket types from public sessions but keeps them for managers', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new EventsSessionRepository({
      eventSession: { findMany },
    } as unknown as PrismaService);
    const input = {
      eventId: '64b64c0000000000000000e1',
      first: 11,
      includeDrafts: false,
      filter: {},
    };

    await repository.findPage(input);
    expect(findMany.mock.calls[0][0].include.ticketTypes).toEqual({
      where: { status: { not: 'INACTIVE' } },
    });

    await repository.findPage({ ...input, includeDrafts: true });
    expect(findMany.mock.calls[1][0].include.ticketTypes).toEqual({});
  });

  it('filters exact placeId while retaining draft visibility and cursor rules', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new EventsSessionRepository({
      eventSession: { findMany },
    } as unknown as PrismaService);

    await repository.findPage({
      eventId: '64b64c0000000000000000e1',
      first: 11,
      afterId: '64b64c0000000000000000e2',
      includeDrafts: false,
      filter: { countryCode: 'US', placeId: 'US-CA' },
    });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      eventId: '64b64c0000000000000000e1',
      countryCode: 'US',
      placeId: 'US-CA',
      AND: [{ status: { not: 'DRAFT' } }],
    });
    expect(args.cursor).toEqual({ id: '64b64c0000000000000000e2' });
    expect(args.skip).toBe(1);
  });
});

describe('EventSessionRepository placeId persistence', () => {
  it('persists catalog placeId on create', async () => {
    const create = vi.fn().mockResolvedValue({ id: 's1' });
    const repository = new EventsSessionRepository({
      eventSession: { create },
    } as unknown as PrismaService);

    await repository.create({
      eventId: 'e1',
      countryCode: 'US',
      city: 'San Francisco',
      placeId: 'US-CA',
      currency: 'USD',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      countryCode: 'US',
      city: 'San Francisco',
      placeId: 'US-CA',
    });
  });

  it('preserves omitted placeId and persists explicit null on draft update', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({ id: 's1' });
    const prisma = {
      eventSession: {
        findFirst: async () => ({
          id: 's1',
          status: 'DRAFT',
          placeId: 'VN-HANOI',
          countryCode: 'VN',
          currency: 'USD',
          event: { status: 'PUBLISHED' },
        }),
        updateMany,
        findUniqueOrThrow,
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    const repository = new EventsSessionRepository(
      prisma as unknown as PrismaService,
    );

    await repository.update({ id: 's1', ownerId: 'u1', name: 'Keep place' });
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('placeId');

    await repository.update({ id: 's1', ownerId: 'u1', placeId: null });
    expect(updateMany.mock.calls[1][0].data).toHaveProperty('placeId', null);
  });

  it('persists replacement placeId when rescheduling', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: 's1',
      version: 2,
    });
    const prisma = {
      eventSession: {
        findFirst: async () => ({
          id: 's1',
          eventId: 'e1',
          status: 'SCHEDULED',
          version: 1,
          event: { status: 'PUBLISHED' },
        }),
        updateMany,
        findUniqueOrThrow,
      },
      outboxEvent: { create: vi.fn() },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    const repository = new EventsSessionRepository(
      prisma as unknown as PrismaService,
    );

    await repository.reschedule('s1', 'u1', {
      countryCode: 'US',
      placeId: 'US-CA',
      city: 'San Francisco',
    });

    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      countryCode: 'US',
      placeId: 'US-CA',
      city: 'San Francisco',
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryRepository } from './inventory.repository';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const hold = {
  id: 'res-1',
  inventoryId: 'inv-1',
  bookingId: 'bk1',
  userId: 'u1',
  quantity: 2,
  status: 'RELEASED',
};

const makePrisma = (count: number) => {
  const tx = {
    inventoryHold: {
      updateMany: vi.fn().mockResolvedValue({ count }),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(hold),
    },
    inventory: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
  };
  return { prisma, tx };
};

describe('InventoryRepository.release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores inventory when the hold is still active', async () => {
    const { prisma, tx } = makePrisma(1);
    const repo = new InventoryRepository(prisma as unknown as PrismaService);

    const result = await repo.release({
      reservationId: 'res-1',
      bookingId: 'bk1',
    });

    expect(tx.inventoryHold.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', bookingId: 'bk1', status: 'ACTIVE' },
      data: { status: 'RELEASED', releasedAt: expect.any(Date) },
    });
    expect(tx.inventory.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: {
        available: { increment: 2 },
        reserved: { decrement: 2 },
        version: { increment: 1 },
      },
    });
    expect(result).toEqual({ released: true, hold });
  });

  it('does not touch inventory when the hold is not active', async () => {
    const { prisma, tx } = makePrisma(0);
    const repo = new InventoryRepository(prisma as unknown as PrismaService);

    const result = await repo.release({
      reservationId: 'res-1',
      bookingId: 'bk1',
    });

    expect(tx.inventory.update).not.toHaveBeenCalled();
    expect(tx.inventoryHold.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(result).toEqual({ released: false });
  });

  it.each(['RELEASED', 'EXPIRED'])(
    'treats a %s hold as already released without touching stock',
    async (status) => {
      const tx = {
        inventoryHold: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue({ ...hold, status }),
          findUniqueOrThrow: vi.fn(),
        },
        inventory: { update: vi.fn() },
      };
      const prisma = { $transaction: vi.fn((cb) => cb(tx)) };
      const repo = new InventoryRepository(prisma as unknown as PrismaService);

      await expect(
        repo.release({ reservationId: 'res-1', bookingId: 'bk1' }),
      ).resolves.toMatchObject({ released: true, alreadyReleased: true });
      expect(tx.inventory.update).not.toHaveBeenCalled();
    },
  );
});

describe('InventoryRepository.getAvailability', () => {
  it('adds back expired active holds, respects sale gates, and never returns negatives', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([
      {
        ticketTypeId: 'ticket-live',
        sessionId: 'session-1',
        total: 5,
        available: 1,
        sold: 1,
        sessionActive: true,
        typeActive: true,
        salesStartAt: null,
        holds: [{ quantity: 2 }],
      },
      {
        ticketTypeId: 'ticket-future',
        sessionId: 'session-1',
        total: 5,
        available: 5,
        sold: 0,
        sessionActive: true,
        typeActive: true,
        salesStartAt: new Date('2026-10-01T00:00:00.000Z'),
        holds: [],
      },
      {
        ticketTypeId: 'ticket-disabled',
        sessionId: 'session-1',
        total: 5,
        available: -1,
        sold: 5,
        sessionActive: false,
        typeActive: false,
        salesStartAt: null,
        holds: [],
      },
    ]);
    const repository = new InventoryRepository({
      inventory: { findMany },
    } as unknown as PrismaService);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      await expect(
        repository.getAvailability([
          { ticketTypeId: 'ticket-live', sessionId: 'session-1' },
          { ticketTypeId: 'ticket-future', sessionId: 'session-1' },
          { ticketTypeId: 'ticket-disabled', sessionId: 'session-1' },
        ]),
      ).resolves.toEqual([
        { ticketTypeId: 'ticket-live', sessionId: 'session-1', availableQuantity: 3 },
        { ticketTypeId: 'ticket-future', sessionId: 'session-1', availableQuantity: 0 },
        { ticketTypeId: 'ticket-disabled', sessionId: 'session-1', availableQuantity: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ticketTypeId: { in: ['ticket-live', 'ticket-future', 'ticket-disabled'] } },
      select: expect.objectContaining({
        holds: {
          where: { status: 'ACTIVE', expiresAt: { lte: now } },
          select: { quantity: true },
        },
      }),
    }));
  });

  it('does not disclose inventory when its session does not match the caller mapping', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        ticketTypeId: 'ticket-1',
        sessionId: 'session-actual',
        total: 4,
        available: 4,
        sold: 0,
        sessionActive: true,
        typeActive: true,
        salesStartAt: null,
        holds: [],
      },
    ]);
    const repository = new InventoryRepository({
      inventory: { findMany },
    } as unknown as PrismaService);

    await expect(
      repository.getAvailability([
        { ticketTypeId: 'ticket-1', sessionId: 'session-requested' },
      ]),
    ).resolves.toEqual([]);
  });
});

describe('InventoryRepository.revoke', () => {
  it('restores sold stock only for the first revoke', async () => {
    const tx = {
      inventoryHold: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...hold,
          status: 'RELEASED',
        }),
        findUnique: vi.fn(),
      },
      inventory: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn((cb) => cb(tx)) };
    const repo = new InventoryRepository(prisma as unknown as PrismaService);

    await repo.revoke({ reservationId: 'res-1', bookingId: 'bk1' });

    expect(tx.inventoryHold.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', bookingId: 'bk1', status: 'CONFIRMED' },
      data: { status: 'RELEASED', releasedAt: expect.any(Date) },
    });
    expect(tx.inventory.update).toHaveBeenCalledTimes(1);
    expect(tx.inventory.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: {
        available: { increment: 2 },
        sold: { decrement: 2 },
        version: { increment: 1 },
      },
    });
  });

  it('treats an expired hold as already returned without touching stock', async () => {
    const tx = {
      inventoryHold: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({
          ...hold,
          status: 'EXPIRED',
        }),
        findUniqueOrThrow: vi.fn(),
      },
      inventory: { update: vi.fn() },
    };
    const prisma = { $transaction: vi.fn((cb) => cb(tx)) };
    const repo = new InventoryRepository(prisma as unknown as PrismaService);

    await expect(
      repo.revoke({ reservationId: 'res-1', bookingId: 'bk1' }),
    ).resolves.toMatchObject({ revoked: true, alreadyRevoked: true });
    expect(tx.inventory.update).not.toHaveBeenCalled();
  });
});

describe('InventoryRepository scheduled reserve', () => {
  const opens = new Date('2026-10-01T00:00:00.000Z');
  const input = {
    ticketTypeId: 'tt1',
    sessionId: 'sess1',
    eventId: 'evt1',
    bookingId: 'bk1',
    userId: 'u1',
    quantity: 1,
  };

  function setup(count: number, fields = {}, catalogFields = {}) {
    const inventory = {
      id: 'inv1',
      ticketTypeId: 'tt1',
      sessionId: 'sess1',
      sessionActive: true,
      typeActive: true,
      available: 10,
      salesStartAt: opens,
      ...fields,
    };
    const catalog = {
      sessionId: 'sess1',
      status: 'SCHEDULED',
      eventId: 'evt1',
      ...catalogFields,
    };
    const tx = {
      inventory: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        findUnique: vi.fn().mockResolvedValue(inventory),
        findUniqueOrThrow: vi.fn().mockResolvedValue(inventory),
      },
      sessionCatalog: { findUnique: vi.fn().mockResolvedValue(catalog) },
      inventoryHold: { create: vi.fn().mockResolvedValue({ id: 'hold1' }) },
    };
    const prisma = { $transaction: vi.fn(async (fn) => fn(tx)) };
    return {
      repo: new InventoryRepository(prisma as unknown as PrismaService),
      tx,
    };
  }

  it('returns a not-started error and creates no hold before opening', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T23:59:59.999Z'));
    try {
      const { repo, tx } = setup(0);
      await expect(repo.reserve(input)).rejects.toMatchObject({
        error: { code: 9, message: 'Ticket sales have not started' },
      });
      expect(tx.inventoryHold.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a ticket type requested for a different session before decrementing', async () => {
    const { repo, tx } = setup(1);

    await expect(
      repo.reserve({ ...input, sessionId: 'sess2' }),
    ).rejects.toMatchObject({ error: { code: 3 } });
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryHold.create).not.toHaveBeenCalled();
  });

  it('rejects a session requested for a different event before decrementing', async () => {
    const { repo, tx } = setup(1);

    await expect(
      repo.reserve({ ...input, eventId: 'evt2' }),
    ).rejects.toMatchObject({ error: { code: 3 } });
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryHold.create).not.toHaveBeenCalled();
  });

  it.each([
    ['inventory session', { sessionId: null }, {}],
    ['catalog event', {}, { eventId: null }],
    ['catalog row', {}, null],
  ])(
    'returns unavailable when the server %s mapping is missing',
    async (_name, fields, catalogFields) => {
      const { repo, tx } = setup(1, fields, catalogFields ?? {});
      if (catalogFields === null) {
        tx.sessionCatalog.findUnique.mockResolvedValue(null);
      }

      await expect(repo.reserve(input)).rejects.toMatchObject({
        error: { code: 14 },
      });
      expect(tx.inventory.updateMany).not.toHaveBeenCalled();
      expect(tx.inventoryHold.create).not.toHaveBeenCalled();
    },
  );

  it('uses the validated inventory/session IDs when reserving', async () => {
    const { repo, tx } = setup(1);

    await expect(repo.reserve(input)).resolves.toMatchObject({
      ticketTypeId: 'tt1',
      sessionId: 'sess1',
      eventId: 'evt1',
    });

    expect(tx.inventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ticketTypeId: 'tt1',
          sessionId: 'sess1',
        }),
      }),
    );
    expect(tx.inventoryHold.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    '2026-09-30T23:59:59.999Z',
    '2026-10-01T00:00:00.000Z',
    '2026-10-01T00:00:00.001Z',
  ])('puts the time gate in the atomic stock update at %s', async (instant) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(instant));
    try {
      const { repo, tx } = setup(1);
      await repo.reserve(input);
      expect(tx.inventory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ticketTypeId: 'tt1',
            sessionId: 'sess1',
            sessionActive: true,
            typeActive: true,
            available: { gte: 1 },
            OR: [
              { salesStartAt: { lte: new Date(instant) } },
              { salesStartAt: null },
              { salesStartAt: { isSet: false } },
            ],
          },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{ sessionActive: false }, { typeActive: false }])(
    'preserves stopped-sale errors %j',
    async (fields) => {
      const { repo, tx } = setup(0, fields);
      await expect(repo.reserve(input)).rejects.toMatchObject({
        error: { code: 9, message: 'Ticket type is not on sale' },
      });
      expect(tx.inventoryHold.create).not.toHaveBeenCalled();
    },
  );

  it('preserves sold-out errors for an already-open sale', async () => {
    const { repo, tx } = setup(0, {
      salesStartAt: new Date('2000-01-01T00:00:00Z'),
      available: 0,
    });
    await expect(repo.reserve(input)).rejects.toMatchObject({
      error: { code: 8 },
    });
    expect(tx.inventoryHold.create).not.toHaveBeenCalled();
  });

  it('persists the opening time when creating inventory', async () => {
    const create = vi.fn(async ({ data }) => data);
    const repo = new InventoryRepository({
      inventory: { create },
    } as unknown as PrismaService);
    const result = await repo.create({
      ticketTypeId: 'tt1',
      total: 10,
      salesStartAt: opens,
    });
    expect(result).toMatchObject({ salesStartAt: opens, available: 10 });
  });

  it('does not change the schedule when updating ticket name or status', async () => {
    const update = vi.fn();
    const repo = new InventoryRepository({
      $transaction: vi.fn(async (fn) =>
        fn({
          inventory: {
            findUnique: vi
              .fn()
              .mockResolvedValue({ id: 'inv1', salesStartAt: opens }),
            update,
          },
        }),
      ),
    } as unknown as PrismaService);
    await repo.applyTicketTypeUpdate('tt1', {
      name: 'New name',
      typeActive: false,
    });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('salesStartAt');
  });
});

describe('InventoryRepository.upsertSessionCatalog event binding', () => {
  it('leaves an existing event binding alone for a legacy message without payload.eventId', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue({ sessionId: 'sess1', eventId: 'evt1' });
    const updateMany = vi.fn();
    const repo = new InventoryRepository({
      sessionCatalog: { upsert, updateMany },
    } as unknown as PrismaService);

    await repo.upsertSessionCatalog('sess1', 'CANCELLED');

    expect(upsert).toHaveBeenCalledWith({
      where: { sessionId: 'sess1' },
      create: { sessionId: 'sess1', status: 'CANCELLED' },
      update: { status: 'CANCELLED' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('conditionally binds only a missing or already matching event ID', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue({ sessionId: 'sess1', eventId: 'evt1' });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repo = new InventoryRepository({
      sessionCatalog: { upsert, updateMany },
    } as unknown as PrismaService);

    await expect(
      repo.upsertSessionCatalog('sess1', 'CANCELLED', 'evt2'),
    ).resolves.toBeDefined();

    expect(upsert).toHaveBeenCalledWith({
      where: { sessionId: 'sess1' },
      create: { sessionId: 'sess1', status: 'CANCELLED', eventId: 'evt2' },
      update: { status: 'CANCELLED' },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        sessionId: 'sess1',
        OR: [
          { eventId: null },
          { eventId: { isSet: false } },
          { eventId: 'evt2' },
        ],
      },
      data: { eventId: 'evt2' },
    });
  });
});

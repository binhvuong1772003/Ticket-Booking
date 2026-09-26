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
});

describe('InventoryRepository scheduled reserve', () => {
  const opens = new Date('2026-10-01T00:00:00.000Z');
  const input = {
    ticketTypeId: 'tt1',
    bookingId: 'bk1',
    userId: 'u1',
    quantity: 1,
  };

  function setup(count: number, fields = {}) {
    const inventory = {
      id: 'inv1',
      ticketTypeId: 'tt1',
      sessionActive: true,
      typeActive: true,
      available: 10,
      salesStartAt: opens,
      ...fields,
    };
    const tx = {
      inventory: {
        updateMany: vi.fn().mockResolvedValue({ count }),
        findUnique: vi.fn().mockResolvedValue(inventory),
        findUniqueOrThrow: vi.fn().mockResolvedValue(inventory),
      },
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

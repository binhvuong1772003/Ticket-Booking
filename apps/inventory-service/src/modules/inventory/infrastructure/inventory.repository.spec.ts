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

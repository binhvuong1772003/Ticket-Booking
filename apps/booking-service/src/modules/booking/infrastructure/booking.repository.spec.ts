import { describe, expect, it, vi } from 'vitest';
import { BookingRepository } from './booking.repository';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

describe('BookingRepository confirmation outbox', () => {
  it('records payment as CONFIRMING without writing booking.confirmed', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const outboxCreate = vi.fn();
    const repository = new BookingRepository({
      booking: { updateMany },
      outboxEvent: { create: outboxCreate },
    } as unknown as PrismaService);

    await repository.recordPaymentSucceeded('bk1');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bk1', status: 'PENDING', paymentStatus: 'PENDING' },
        data: expect.objectContaining({
          status: 'CONFIRMING',
          paymentStatus: 'PAID',
        }),
      }),
    );
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('creates booking.confirmed in the successful conditional completion transaction', async () => {
    const order: string[] = [];
    const tx = {
      booking: {
        updateMany: vi.fn(async () => {
          order.push('transition');
          return { count: 1 };
        }),
        findUniqueOrThrow: vi.fn(async () => {
          order.push('read');
          return {
            id: 'bk1',
            userId: 'user-1',
            eventId: 'event-1',
            sessionId: 'session-1',
            currency: 'VND',
            version: 7,
            items: [
              {
                id: 'item-1',
                ticketTypeId: 'tt-1',
                ticketTypeName: 'VIP',
                ticketTypeCode: 'VIP',
                quantity: 2,
                unitPrice: 800000,
                unitPriceMinor: 800000,
              },
            ],
          };
        }),
      },
      outboxEvent: {
        create: vi.fn(async () => {
          order.push('outbox');
        }),
      },
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    const repository = new BookingRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await repository.completeConfirmation('bk1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['transition', 'read', 'outbox']);
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'bk1',
          status: 'CONFIRMING',
          paymentStatus: 'PAID',
        },
        data: expect.objectContaining({
          status: 'CONFIRMED',
          confirmedAt: expect.any(Date),
          version: { increment: 1 },
        }),
      }),
    );
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateId: 'bk1',
        eventType: 'booking.confirmed',
        aggregateVersion: 7,
        payload: {
          booking_id: 'bk1',
          user_id: 'user-1',
          event_id: 'event-1',
          session_id: 'session-1',
          currency: 'VND',
          items: [
            {
              booking_item_id: 'item-1',
              ticket_type_id: 'tt-1',
              ticket_type_name: 'VIP',
              ticket_type_code: 'VIP',
              quantity: 2,
              unit_price_minor: '800000',
            },
          ],
        },
      },
    });
  });

  it('does not create an outbox event when the conditional completion loses', async () => {
    const findUniqueOrThrow = vi.fn();
    const outboxCreate = vi.fn();
    const tx = {
      booking: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow,
      },
      outboxEvent: { create: outboxCreate },
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    const repository = new BookingRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await repository.completeConfirmation('bk1');

    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('preserves terminal states when recording a late payment', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const repository = new BookingRepository({
      booking: { updateMany },
    } as unknown as PrismaService);

    await repository.recordPaymentSucceeded('bk1');

    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: 'bk1',
          status: { in: ['CANCELLED', 'EXPIRED'] },
          paymentStatus: 'PENDING',
        },
        data: expect.objectContaining({
          paymentStatus: 'PAID',
          paidAt: expect.any(Date),
        }),
      }),
    );
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty('status');
  });
});

describe('BookingRepository refund recovery', () => {
  it('persists cancellation and compensation work for every active event booking', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 4 });
    const repository = new BookingRepository({
      booking: { updateMany },
    } as unknown as PrismaService);

    await repository.cancelActiveByEvent('evt1', 'Event cancelled');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        eventId: 'evt1',
        status: { in: ['PENDING', 'CONFIRMING', 'CONFIRMED'] },
      },
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancelledAt: expect.any(Date),
        cancellationReason: 'Event cancelled',
        inventoryCompensationPending: true,
        inventoryReleasedAt: null,
        nextCompensationAttemptAt: null,
        version: { increment: 1 },
      }),
    });
  });

  it('preserves the refund retry schedule after inventory release for a paid booking', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const repository = new BookingRepository({
      booking: { updateMany },
    } as unknown as PrismaService);

    await repository.markInventoryReleased('bk1');

    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ inventoryReleasedAt: expect.any(Date) }),
      }),
    );
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty(
      'nextCompensationAttemptAt',
    );
  });

  it('includes legacy terminal rows without the compensation marker', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new BookingRepository({
      booking: { findMany },
    } as unknown as PrismaService);

    const now = new Date('2026-09-28T00:00:00.000Z');
    await repository.findRefundWork(now, 100);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['EXPIRED', 'CANCELLED'] },
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                { inventoryCompensationPending: { isSet: false } },
              ]),
            }),
            {
              OR: [
                { nextCompensationAttemptAt: { lte: now } },
                { nextCompensationAttemptAt: null },
                { nextCompensationAttemptAt: { isSet: false } },
              ],
            },
          ]),
        }),
        orderBy: [
          { nextCompensationAttemptAt: 'asc' },
          { paidAt: 'asc' },
        ],
        take: 100,
      }),
    );
  });

  it('claims a due compensation row and schedules its next attempt', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new BookingRepository({
      booking: { updateMany },
    } as unknown as PrismaService);
    const now = new Date('2026-09-28T00:00:00.000Z');

    await repository.claimRefundWork('bk1', now, 60_000);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'bk1',
          status: { in: ['EXPIRED', 'CANCELLED'] },
          AND: expect.arrayContaining([
            {
              OR: [
                { nextCompensationAttemptAt: { lte: now } },
                { nextCompensationAttemptAt: null },
                { nextCompensationAttemptAt: { isSet: false } },
              ],
            },
          ]),
        }),
        data: {
          nextCompensationAttemptAt: new Date(now.getTime() + 60_000),
        },
      }),
    );
  });
});

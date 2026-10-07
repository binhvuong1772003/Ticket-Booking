import { describe, expect, it, vi } from 'vitest';
import { BookingRepository } from './booking.repository';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

describe('BookingRepository.aggregateTrendingSales', () => {
  it('aggregates confirmed ticket quantities and continues after a stable cursor', async () => {
    const aggregateRaw = vi.fn().mockResolvedValue([
      { eventId: '64b64c0000000000000000e2', confirmedQuantity: 5 },
    ]);
    const repository = new BookingRepository({
      booking: { aggregateRaw },
    } as unknown as PrismaService);

    await repository.aggregateTrendingSales({
      since: new Date('2026-09-22T10:00:00.000Z'),
      first: 11,
      after: { confirmedQuantity: 7, eventId: 'event-1' },
    });

    const pipeline = aggregateRaw.mock.calls[0][0].pipeline;
    expect(pipeline[0]).toEqual({
      $match: {
        confirmedAt: { $gte: { $date: '2026-09-22T10:00:00.000Z' } },
        $or: [
          { paymentStatus: { $in: ['PAID', 'REFUNDING'] } },
          { status: 'CONFIRMED', paymentStatus: 'PENDING', totalAmount: 0 },
        ],
      },
    });
    expect(pipeline).toContainEqual({
      $lookup: {
        from: 'booking_items',
        localField: '_id',
        foreignField: 'bookingId',
        as: 'items',
      },
    });
    expect(pipeline).toContainEqual({ $unwind: '$items' });
    expect(pipeline).toContainEqual({
      $group: {
        _id: '$eventId',
        confirmedQuantity: { $sum: '$items.quantity' },
      },
    });
    expect(pipeline).toContainEqual({
      $match: {
        $or: [
          { confirmedQuantity: { $lt: 7 } },
          { confirmedQuantity: 7, _id: { $gt: 'event-1' } },
        ],
      },
    });
    expect(pipeline.at(-3)).toEqual({
      $sort: { confirmedQuantity: -1, _id: 1 },
    });
    expect(pipeline.at(-2)).toEqual({ $limit: 11 });
    expect(pipeline.at(-1)).toEqual({
      $project: { _id: 0, eventId: '$_id', confirmedQuantity: 1 },
    });
  });
});

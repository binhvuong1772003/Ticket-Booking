import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/booking-prisma';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export type CreateBookingData = {
  id: string;
  userId: string;
  eventId: string;
  sessionId: string;
  ticketTypeId: string;
  ticketTypeName: string;
  ticketTypeCode: string;
  quantity: number;
  unitPrice: number;
  unitPriceMinor: number;
  currency: string;
  reservationId: string;
  expiresAt: Date;
};

export type TrendingSalesCursor = {
  confirmedQuantity: number;
  eventId: string;
};

@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPending(data: CreateBookingData) {
    const unitPrice = data.unitPrice;
    const subtotal = unitPrice * data.quantity;

    return this.prisma.booking.create({
      data: {
        id: data.id,
        userId: data.userId,
        eventId: data.eventId,
        sessionId: data.sessionId,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        subtotal,
        discountAmount: 0,
        feeAmount: 0,
        totalAmount: subtotal,
        currency: data.currency,
        expiresAt: data.expiresAt,
        items: {
          create: {
            ticketTypeId: data.ticketTypeId,
            ticketTypeName: data.ticketTypeName,
            ticketTypeCode: data.ticketTypeCode,
            quantity: data.quantity,
            unitPrice,
            unitPriceMinor: data.unitPriceMinor,
            subtotal,
            reservationId: data.reservationId,
          },
        },
      },
      include: { items: true },
    });
  }

  cancel(bookingId: string, reason: string) {
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
        inventoryCompensationPending: true,
        inventoryReleasedAt: null,
        nextCompensationAttemptAt: null,
        version: { increment: 1 },
      },
      include: { items: true },
    });
  }

  findById(id: string) {
    return this.prisma.booking.findUnique({
      where: { id },
      include: { items: true },
    });
  }

  updateRecipientIfPending(
    bookingId: string,
    userId: string,
    recipientFullName: string,
    recipientEmail: string,
    now = new Date(),
  ) {
    return this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        userId,
        status: 'PENDING',
        paymentStatus: 'PENDING',
        expiresAt: { gt: now },
      },
      data: { recipientFullName, recipientEmail },
    });
  }

  async ticketBookingItemSnapshot(itemId: string) {
    const item = await this.prisma.bookingItem.findUnique({
      where: { id: itemId },
      include: { booking: true },
    });
    if (!item || item.booking.status !== 'CONFIRMED' || item.booking.paymentStatus !== 'PAID') {
      return null;
    }
    return {
      unitPriceMinor: item.unitPriceMinor == null ? null : String(item.unitPriceMinor),
      unitPrice: String(item.unitPrice),
      currency: item.booking.currency,
    };
  }

  async aggregateTrendingSales(input: {
    since: Date;
    first: number;
    after?: TrendingSalesCursor;
  }) {
    const pipeline = [
      {
        $match: {
          confirmedAt: { $gte: { $date: input.since.toISOString() } },
          $or: [
            { paymentStatus: { $in: ['PAID', 'REFUNDING'] } },
            { status: 'CONFIRMED', paymentStatus: 'PENDING', totalAmount: 0 },
          ],
        },
      },
      {
        $lookup: {
          from: 'booking_items',
          localField: '_id',
          foreignField: 'bookingId',
          as: 'items',
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$eventId',
          confirmedQuantity: { $sum: '$items.quantity' },
        },
      },
      ...(input.after
        ? [
            {
              $match: {
                $or: [
                  { confirmedQuantity: { $lt: input.after.confirmedQuantity } },
                  {
                    confirmedQuantity: input.after.confirmedQuantity,
                    _id: { $gt: input.after.eventId },
                  },
                ],
              },
            },
          ]
        : []),
      { $sort: { confirmedQuantity: -1, _id: 1 } },
      { $limit: input.first },
      { $project: { _id: 0, eventId: '$_id', confirmedQuantity: 1 } },
    ];
    const raw = (await this.prisma.booking.aggregateRaw({
      pipeline,
    })) as unknown as { eventId: unknown; confirmedQuantity: unknown }[];

    return raw.map((row) => {
      if (
        typeof row.eventId !== 'string' ||
        !Number.isSafeInteger(row.confirmedQuantity) ||
        (row.confirmedQuantity as number) < 1
      ) {
        throw new Error('Booking trend aggregation returned invalid data');
      }
      return {
        eventId: row.eventId,
        confirmedQuantity: row.confirmedQuantity as number,
      };
    });
  }

  // Chỉ PENDING được bắt đầu xác nhận; terminal booking chỉ ghi nhận khoản
  // tiền đến muộn để refund, không bị đưa trở lại luồng cấp vé.
  async recordPaymentSucceeded(bookingId: string) {
    const now = new Date();
    const result = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: 'PENDING',
        paymentStatus: 'PENDING',
      },
      data: {
        status: 'CONFIRMING',
        paymentStatus: 'PAID',
        paidAt: now,
        confirmationAttempts: 0,
        nextConfirmationAttemptAt: now,
        confirmationLastError: null,
        version: { increment: 1 },
      },
    });
    if (result.count !== 0) {
      return result;
    }

    return this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ['CANCELLED', 'EXPIRED'] },
        paymentStatus: 'PENDING',
      },
      data: {
        paymentStatus: 'PAID',
        paidAt: now,
        version: { increment: 1 },
      },
    });
  }

  claimConfirmation(bookingId: string, now: Date, retryDelay: number) {
    return this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: 'CONFIRMING',
        paymentStatus: 'PAID',
        OR: [
          { nextConfirmationAttemptAt: { lte: now } },
          { nextConfirmationAttemptAt: null },
          { nextConfirmationAttemptAt: { isSet: false } },
        ],
      },
      data: {
        confirmationAttempts: { increment: 1 },
        nextConfirmationAttemptAt: new Date(now.getTime() + retryDelay),
      },
    });
  }

  findConfirming(now: Date, take: number) {
    return this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMING',
        paymentStatus: 'PAID',
        OR: [
          { nextConfirmationAttemptAt: { lte: now } },
          { nextConfirmationAttemptAt: null },
          { nextConfirmationAttemptAt: { isSet: false } },
        ],
      },
      include: { items: true },
      orderBy: { paidAt: 'asc' },
      take,
    });
  }

  noteConfirmationFailure(bookingId: string, message: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'CONFIRMING', paymentStatus: 'PAID' },
      data: { confirmationLastError: message.slice(0, 1000) },
    });
  }

  completeConfirmation(bookingId: string) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.booking.updateMany({
        where: {
          id: bookingId,
          status: 'CONFIRMING',
          paymentStatus: 'PAID',
        },
        data: {
          status: 'CONFIRMED',
          confirmedAt: now,
          nextConfirmationAttemptAt: null,
          confirmationLastError: null,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) {
        return result;
      }

      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { items: true },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: bookingId,
          eventType: 'booking.confirmed',
          aggregateVersion: booking.version,
          payload: {
            booking_id: booking.id,
            user_id: booking.userId,
            event_id: booking.eventId,
            session_id: booking.sessionId,
            currency: booking.currency,
            items: booking.items.map((item) => ({
              booking_item_id: item.id,
              ticket_type_id: item.ticketTypeId,
              ticket_type_name: item.ticketTypeName,
              ticket_type_code: item.ticketTypeCode,
              quantity: item.quantity,
              unit_price_minor:
                item.unitPriceMinor == null
                  ? null
                  : String(item.unitPriceMinor),
            })),
          },
        },
      });
      return result;
    });
  }

  expireIfPending(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: {
        status: 'EXPIRED',
        expiredAt: new Date(),
        inventoryCompensationPending: true,
        inventoryReleasedAt: null,
        version: { increment: 1 },
      },
    });
  }

  markPaymentFailed(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: {
        paymentFailedAt: new Date(),
        version: { increment: 1 },
      },
    });
  }

  // Refund intent đã được payment-service ghi nhận — tiền đang hoàn,
  // frontend đọc REFUNDING để hiển thị "đang hoàn tiền".
  markRefunding(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, paymentStatus: 'PAID' },
      data: {
        paymentStatus: 'REFUNDING',
        version: { increment: 1 },
      },
    });
  }

  markRefunded(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, paymentStatus: { in: ['PAID', 'REFUNDING'] } },
      data: {
        paymentStatus: 'REFUNDED',
        refundedAt: new Date(),
        version: { increment: 1 },
      },
    });
  }

  // Cancel in-flight/confirmed booking before external refund or inventory
  // calls. A terminal row only gets its durable compensation flag refreshed.
  async cancelForRefund(bookingId: string, reason: string) {
    const result = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ['PENDING', 'CONFIRMING', 'CONFIRMED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
        inventoryCompensationPending: true,
        inventoryReleasedAt: null,
        version: { increment: 1 },
      },
    });
    if (result.count !== 0) {
      return result;
    }
    const terminal = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ['CANCELLED', 'EXPIRED'] },
        OR: [
          { cancellationReason: null },
          { cancellationReason: { isSet: false } },
        ],
      },
      data: {
        cancellationReason: reason,
        inventoryCompensationPending: true,
      },
    });
    if (terminal.count !== 0) {
      return terminal;
    }
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: { in: ['CANCELLED', 'EXPIRED'] } },
      data: { inventoryCompensationPending: true },
    });
  }

  // Persist cancellation work for the sweeper before acknowledging event.cancelled.
  cancelActiveByEvent(eventId: string, reason: string) {
    return this.prisma.booking.updateMany({
      where: {
        eventId,
        status: { in: ['PENDING', 'CONFIRMING', 'CONFIRMED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
        inventoryCompensationPending: true,
        inventoryReleasedAt: null,
        nextCompensationAttemptAt: null,
        version: { increment: 1 },
      },
    });
  }

  clearInventoryCompensation(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ['CANCELLED', 'EXPIRED'] },
        paymentStatus: { in: ['PENDING', 'FAILED', 'REFUNDED'] },
      },
      data: {
        inventoryCompensationPending: false,
        nextCompensationAttemptAt: null,
      },
    });
  }

  markInventoryReleased(bookingId: string) {
    const result = this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: ['CANCELLED', 'EXPIRED'] },
        inventoryCompensationPending: true,
        paymentStatus: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        inventoryReleasedAt: new Date(),
        inventoryCompensationPending: false,
        nextCompensationAttemptAt: null,
      },
    });
    return result.then((updated) => {
      if (updated.count !== 0) {
        return updated;
      }
      return this.prisma.booking.updateMany({
        where: {
          id: bookingId,
          status: { in: ['CANCELLED', 'EXPIRED'] },
          inventoryCompensationPending: true,
        },
        data: { inventoryReleasedAt: new Date() },
      });
    });
  }

  private refundWorkWhere(now: Date): Prisma.BookingWhereInput {
    return {
      status: { in: ['EXPIRED', 'CANCELLED'] },
      AND: [
        {
          OR: [
            { paymentStatus: 'PAID' },
            { inventoryCompensationPending: null },
            { inventoryCompensationPending: { isSet: false } },
            {
              inventoryCompensationPending: true,
              OR: [
                { inventoryReleasedAt: null },
                { inventoryReleasedAt: { isSet: false } },
                { paymentStatus: 'REFUNDED' },
              ],
            },
          ],
        },
        {
          OR: [
            { nextCompensationAttemptAt: { lte: now } },
            { nextCompensationAttemptAt: null },
            { nextCompensationAttemptAt: { isSet: false } },
          ],
        },
      ],
    };
  }

  claimRefundWork(bookingId: string, now: Date, retryDelay: number) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, ...this.refundWorkWhere(now) },
      data: {
        nextCompensationAttemptAt: new Date(now.getTime() + retryDelay),
      },
    });
  }

  // Bounded retry queue for refunds and inventory compensation. Per-row
  // scheduling prevents persistent failures from occupying every sweep batch.
  findRefundWork(now: Date, take: number) {
    return this.prisma.booking.findMany({
      where: this.refundWorkWhere(now),
      include: { items: true },
      orderBy: [
        { nextCompensationAttemptAt: 'asc' },
        { paidAt: 'asc' },
      ],
      take,
    });
  }

  findExpiredPending(now: Date, take: number) {
    return this.prisma.booking.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      include: { items: true },
      orderBy: { expiresAt: 'asc' },
      take,
    });
  }

  /* ---- Read queries cho organizer/customer ---- */

  findByEvent(eventId: string) {
    return this.prisma.booking.findMany({
      where: { eventId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  findBySession(sessionId: string) {
    return this.prisma.booking.findMany({
      where: { sessionId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  findByUser(userId: string) {
    return this.prisma.booking.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /* ---- EventCatalog projection (eventId → organizerId) ---- */

  upsertEventCatalog(eventId: string, organizerId: string) {
    return this.prisma.eventCatalog.upsert({
      where: { eventId },
      create: { eventId, organizerId },
      update: { organizerId },
    });
  }

  async eventOwnerOf(eventId: string) {
    const catalog = await this.prisma.eventCatalog.findUnique({
      where: { eventId },
    });
    return catalog?.organizerId ?? null;
  }
}

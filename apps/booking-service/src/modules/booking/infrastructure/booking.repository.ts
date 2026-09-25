import { Injectable } from '@nestjs/common';
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
  currency: string;
  reservationId: string;
  expiresAt: Date;
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

  // Conditional writes: mọi transition đều guard bằng status hiện tại để
  // consumer Kafka (at-least-once) và sweeper chạy lại/trùng vẫn an toàn.
  confirmPaid(bookingId: string) {
    const now = new Date();
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: {
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        confirmedAt: now,
        paidAt: now,
        version: { increment: 1 },
      },
    });
  }

  expireIfPending(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: {
        status: 'EXPIRED',
        expiredAt: new Date(),
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

  // Tiền đã thu nhưng booking không confirm được (trả trễ/mất hold):
  // ghi nhận PAID để trạng thái kẹt query được trước khi refund xong.
  markPaid(bookingId: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, paymentStatus: 'PENDING' },
      data: {
        paymentStatus: 'PAID',
        paidAt: new Date(),
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

  // Cancel có điều kiện cho cascade event.cancelled: chỉ PENDING mới flip,
  // CONFIRMED đi qua refundAndCancel, terminal skip.
  cancelIfPending(bookingId: string, reason: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
        version: { increment: 1 },
      },
    });
  }

  // Booking còn "sống" của 1 event: PENDING (chưa trả) hoặc CONFIRMED
  // (đã bán — cần refund khi event huỷ).
  findActiveByEvent(eventId: string, take: number) {
    return this.prisma.booking.findMany({
      where: { eventId, status: { in: ['PENDING', 'CONFIRMED'] } },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // Idempotent cancel cho retry: đã CANCELLED thì không stamp lại
  // cancelledAt/cancellationReason.
  cancelUnlessCancelled(bookingId: string, reason: string) {
    return this.prisma.booking.updateMany({
      where: { id: bookingId, status: { not: 'CANCELLED' } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason,
        version: { increment: 1 },
      },
    });
  }

  // Booking đã đóng (EXPIRED/CANCELLED) nhưng tiền đã thu chưa hoàn —
  // đây cũng là query ops dùng để đối soát tiền treo.
  findTerminalPaid(take: number) {
    return this.prisma.booking.findMany({
      where: {
        status: { in: ['EXPIRED', 'CANCELLED'] },
        paymentStatus: 'PAID',
      },
      orderBy: { paidAt: 'asc' },
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

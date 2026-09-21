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
}

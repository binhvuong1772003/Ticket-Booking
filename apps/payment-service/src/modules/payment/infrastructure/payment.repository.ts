import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '../../../generated/payment-prisma';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export type CreatePaymentInput = {
  bookingId: string;
  checkoutSessionId: string;
  organizerAccountId?: string;
  amount: number;
  currency: string;
};

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePaymentInput) {
    return this.prisma.payment.create({
      data: {
        bookingId: input.bookingId,
        checkoutSessionId: input.checkoutSessionId,
        organizerAccountId: input.organizerAccountId || null,
        amount: input.amount,
        currency: input.currency,
      },
    });
  }

  findByStripeRef(ref: {
    checkoutSessionId?: string;
    paymentIntentId?: string;
    bookingId?: string;
  }) {
    return this.prisma.payment.findFirst({
      where: {
        OR: [
          { checkoutSessionId: ref.checkoutSessionId ?? undefined },
          { paymentIntentId: ref.paymentIntentId ?? undefined },
          { bookingId: ref.bookingId ?? undefined },
        ].filter((clause) => Object.values(clause)[0] !== undefined),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Ghi trạng thái payment + outbox event trong 1 transaction.
   * Ném P2002 nếu stripeEventId đã tồn tại → caller coi là duplicate.
   */
  async recordWebhookEvent(input: {
    paymentId?: string;
    status?: PaymentStatus;
    paymentIntentId?: string;
    stripeEventId: string;
    eventType: string;
    payload: object;
  }) {
    const ops = [];
    if (input.paymentId && input.status) {
      ops.push(
        this.prisma.payment.update({
          where: { id: input.paymentId },
          data: {
            status: input.status,
            paymentIntentId: input.paymentIntentId ?? undefined,
            succeededAt: input.status === 'SUCCEEDED' ? new Date() : undefined,
          },
        }),
      );
    }
    ops.push(
      this.prisma.paymentOutbox.create({
        data: {
          stripeEventId: input.stripeEventId,
          eventType: input.eventType,
          payload: input.payload,
        },
      }),
    );
    await this.prisma.$transaction(ops);
  }
}

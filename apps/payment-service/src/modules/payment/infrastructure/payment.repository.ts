import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '../../../generated/payment-prisma';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export type CreatePaymentInput = {
  bookingId: string;
  checkoutSessionId: string;
  userId?: string;
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
        userId: input.userId || null,
        checkoutSessionId: input.checkoutSessionId,
        organizerAccountId: input.organizerAccountId || null,
        amount: input.amount,
        currency: input.currency,
      },
    });
  }

  findById(id: string) {
    return this.prisma.payment.findUnique({ where: { id } });
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
   * Ghi intent refund — chỉ từ SUCCEEDED và chỉ set lần đầu để giữ
   * timestamp request gốc. Execution (Stripe) nằm ở refund worker.
   */
  requestRefund(paymentId: string) {
    return this.prisma.payment.updateMany({
      where: {
        id: paymentId,
        status: 'SUCCEEDED',
        refundRequestedAt: { isSet: false },
      },
      data: { refundRequestedAt: new Date() },
    });
  }

  // Backstop sweep: intent đã ghi nhưng job queue mất (Redis flush) →
  // caller re-enqueue (dedup bằng jobId nên job còn sống thì no-op).
  findPendingRefunds(take: number) {
    return this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED', refundRequestedAt: { isSet: true } },
      orderBy: { refundRequestedAt: 'asc' },
      take,
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

  /**
   * Đánh dấu payment đã refund + ghi outbox payment.refunded trong 1 tx.
   * Dedup: stripeEventId = refund.id nên retry sau crash không ghi trùng.
   */
  markRefunded(input: {
    paymentId: string;
    refundId: string;
    payload: object;
  }) {
    return this.prisma.$transaction([
      this.prisma.payment.updateMany({
        where: { id: input.paymentId, status: 'SUCCEEDED' },
        data: {
          status: 'REFUNDED',
          stripeRefundId: input.refundId,
          refundedAt: new Date(),
        },
      }),
      this.prisma.paymentOutbox.create({
        data: {
          stripeEventId: input.refundId,
          eventType: 'payment.refunded',
          payload: input.payload,
        },
      }),
    ]);
  }
}

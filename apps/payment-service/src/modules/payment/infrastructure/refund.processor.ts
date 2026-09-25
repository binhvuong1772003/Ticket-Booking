import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { Prisma } from '../../../generated/payment-prisma';
import { StripeService } from '../application/stripe.service';
import { OutboxProcessor } from './outbox.processor';
import { PaymentRepository } from './payment.repository';

type RefundJob = { paymentId: string };

@Processor('refund')
export class RefundProcessor extends WorkerHost {
  private readonly logger = new Logger(RefundProcessor.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly repository: PaymentRepository,
    private readonly outbox: OutboxProcessor,
  ) {
    super();
  }

  async process(job: Job<RefundJob>) {
    const payment = await this.repository.findById(job.data.paymentId);
    if (!payment) {
      throw new UnrecoverableError(`payment ${job.data.paymentId} not found`);
    }
    if (payment.status === 'REFUNDED') {
      return;
    }
    if (payment.status !== 'SUCCEEDED' || !payment.paymentIntentId) {
      // Intent chỉ ghi khi SUCCEEDED; status đổi sau đó (race hẹp) thì
      // không retry vô nghĩa.
      throw new UnrecoverableError(
        `payment ${payment.id} not refundable (status ${payment.status})`,
      );
    }

    // Idempotency key theo payment id: retry sau crash không tạo double refund.
    const refund = await this.stripeService.refund(
      payment.paymentIntentId,
      `refund-${payment.id}`,
    );

    try {
      await this.repository.markRefunded({
        paymentId: payment.id,
        refundId: refund.id,
        payload: {
          booking_id: payment.bookingId,
          user_id: payment.userId,
          payment_intent_id: payment.paymentIntentId,
          refund_id: refund.id,
          amount: payment.amount,
          currency: payment.currency,
        },
      });
    } catch (error) {
      // Outbox đã có event cùng stripeEventId=refund.id → worker khác/retry
      // đã ghi; coi như xong thay vì fail job.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }

    this.outbox.wake();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    this.logger.error(
      `Refund job failed (attempt ${job?.attemptsMade ?? '?'}): ${error.message}`,
    );
  }
}

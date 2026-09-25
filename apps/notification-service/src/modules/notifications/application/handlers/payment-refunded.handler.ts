import { Injectable, Logger } from '@nestjs/common';
import type { PaymentRefundedEvent } from '../../../../../../../libs/contracts/src/events/payment/payment-refunded.event';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class PaymentRefundedEmailHandler {
  private readonly logger = new Logger(PaymentRefundedEmailHandler.name);

  constructor(@InjectQueue('email') private readonly emailQueue: Queue) {}

  async handlePaymentRefunded(event: PaymentRefundedEvent) {
    const { booking_id, user_id, amount, currency } = event.payload;
    if (!user_id) {
      this.logger.warn(
        `payment.refunded ${event.eventId} thiếu user_id — không gửi email`,
      );
      return;
    }

    await this.emailQueue.add(
      'refund-email',
      {
        eventId: event.eventId,
        bookingId: booking_id,
        userId: user_id,
        amount: amount ?? null,
        currency: currency ?? null,
      },
      {
        // Dedup theo outbox eventId — Kafka redelivery không gửi trùng mail.
        jobId: `refund-email-${event.eventId}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { PaymentRefundedEvent } from '../../../../../../../libs/contracts/src/events/payment/payment-refunded.event';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationEmailDeliveryRepository } from '../../infrastructure/email/notification-email-delivery.repository.js';

@Injectable()
export class PaymentRefundedEmailHandler {
  private readonly logger = new Logger(PaymentRefundedEmailHandler.name);

  constructor(
    @InjectQueue('email') private readonly emailQueue: Queue,
    private readonly deliveries: NotificationEmailDeliveryRepository,
  ) {}

  async handlePaymentRefunded(event: PaymentRefundedEvent) {
    const { booking_id, user_id, amount, currency } = event.payload;
    if (!user_id) {
      this.logger.warn(
        `payment.refunded ${event.eventId} thiếu user_id — không gửi email`,
      );
      return;
    }

    if (!event.eventId || !booking_id)
      throw new Error('Invalid payment.refunded event');
    const delivery = await this.deliveries.createOrGet({
      kind: 'REFUND',
      eventId: event.eventId,
      payload: {
        bookingId: booking_id,
        userId: user_id,
        amount: amount ?? null,
        currency: currency ?? null,
      },
    });
    if (delivery.status === 'SENT' || delivery.status === 'FAILED') return;

    await this.emailQueue.add(
      'refund-email',
      { deliveryId: delivery.id },
      {
        jobId: `notification-email-${delivery.id}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}

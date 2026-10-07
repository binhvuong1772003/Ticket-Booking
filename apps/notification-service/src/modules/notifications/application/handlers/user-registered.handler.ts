import { Injectable } from '@nestjs/common';
import type { UserRegisteredEvent } from '../../../../../../../libs/contracts/src/events/auth/user-registered.event';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationEmailDeliveryRepository } from '../../infrastructure/email/notification-email-delivery.repository.js';

@Injectable()
export class UserRegisteredEmailHandler {
  constructor(
    @InjectQueue('email') private readonly emailQueue: Queue,
    private readonly deliveries: NotificationEmailDeliveryRepository,
  ) {}

  async handleUserRegistered(event: UserRegisteredEvent) {
    const { eventId, occurredAt, payload } = event;
    const occurredAtMs = Date.parse(occurredAt);
    if (
      !eventId ||
      !Number.isFinite(occurredAtMs) ||
      !payload.email ||
      !payload.verificationToken
    ) {
      throw new Error('Invalid auth.user.registered event');
    }

    const delivery = await this.deliveries.createOrGet({
      kind: 'VERIFICATION',
      eventId,
      payload: {
        to: payload.email,
        verificationToken: payload.verificationToken,
      },
      expiresAt: new Date(occurredAtMs + 24 * 60 * 60 * 1000),
    });
    if (delivery.status === 'SENT' || delivery.status === 'FAILED') return;

    await this.emailQueue.add(
      'verification-email',
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

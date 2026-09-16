import { Injectable } from '@nestjs/common';
import type { UserRegisteredEvent } from '../../../../../../../libs/contracts/src/events/auth/user-registered.event';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class UserRegisteredEmailHandler {
  constructor(@InjectQueue('email') private readonly emailQueue: Queue) {}

  async handleUserRegistered(event: UserRegisteredEvent) {
    await this.emailQueue.add(
      'verification-email',
      {
        eventId: event.eventId,
        to: event.payload.email,
        verificationToken: event.payload.verificationToken,
      },
      {
        jobId: event.eventId,
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

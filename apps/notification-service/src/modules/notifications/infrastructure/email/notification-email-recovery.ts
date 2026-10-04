import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { NotificationEmailDeliveryRepository } from './notification-email-delivery.repository';

@Injectable()
export class NotificationEmailRecovery
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationEmailRecovery.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly deliveries: NotificationEmailDeliveryRepository,
    @InjectQueue('email') private readonly emailQueue: Queue,
  ) {}

  async onModuleInit() {
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), 15_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      let queued: Array<{ id: string }>;
      try {
        queued = await this.deliveries.recoverable(100);
      } catch (error) {
        this.logger.warn(
          `Notification email recovery query failed: ${this.errorCode(error)}`,
        );
        return;
      }
      for (const { id } of queued) {
        try {
          await this.emailQueue.add(
            'notification-email',
            { deliveryId: id },
            {
              jobId: `notification-email-${id}`,
              attempts: 5,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: true,
            },
          );
        } catch (error) {
          this.logger.warn(
            `Notification email enqueue failed (${id}): ${this.errorCode(error)}`,
          );
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private errorCode(error: unknown) {
    return (
      (error as { code?: string })?.code ??
      (error instanceof Error ? error.name : 'UNKNOWN')
    );
  }
}

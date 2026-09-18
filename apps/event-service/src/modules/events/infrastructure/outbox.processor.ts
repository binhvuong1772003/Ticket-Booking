import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

const OUTBOX_BATCH_SIZE = 50;
const OUTBOX_POLL_INTERVAL_MS = 30_000;

@Injectable()
export class OutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxProcessor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private connected = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('EVENT_KAFKA_CLIENT')
    private readonly kafkaClient: ClientKafka,
  ) {}

  onModuleInit() {
    this.logger.log('Outbox processor started');
    void this.publishPending();
    this.timer = setInterval(
      () => void this.publishPending(),
      OUTBOX_POLL_INTERVAL_MS,
    );
  }

  wake() {
    void this.publishPending();
  }

  async onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    if (this.connected) {
      await this.kafkaClient.close();
      this.connected = false;
    }
  }

  private async ensureConnected() {
    if (this.connected) {
      return true;
    }

    try {
      await this.kafkaClient.connect();
      this.connected = true;
      return true;
    } catch (error: unknown) {
      this.logger.error(`Kafka connection failed: ${String(error)}`);
      return false;
    }
  }

  private async publishPending() {
    if (!(await this.ensureConnected()) || this.running) {
      return;
    }

    this.running = true;

    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          OR: [{ publishedAt: null }, { publishedAt: { isSet: false } }],
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: OUTBOX_BATCH_SIZE,
      });

      this.logger.log(`Found ${events.length} pending outbox event(s)`);

      for (const event of events) {
        await this.publish(event);
      }
    } catch (error: unknown) {
      this.logger.error(`Outbox polling failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async publish(event: {
    id: string;
    eventType: string;
    payload: unknown;
    createdAt: Date;
    attempts: number;
  }) {
    try {
      await firstValueFrom(
        this.kafkaClient.emit(event.eventType, {
          eventId: event.id,
          eventType: event.eventType,
          occurredAt: event.createdAt.toISOString(),
          payload: event.payload,
        }),
      );

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          publishedAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(`Published outbox event ${event.id}: ${event.eventType}`);
    } catch (error: unknown) {
      const attempts = event.attempts + 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          nextAttemptAt: new Date(Date.now() + delay),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });

      this.logger.error(
        `Failed to publish outbox event ${event.id}: ${String(error)}`,
      );
    }
  }
}

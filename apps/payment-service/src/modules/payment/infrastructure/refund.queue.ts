import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PaymentRepository } from './payment.repository';

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH_SIZE = 50;

// ponytail: backstop sweep chạy trên mọi replica — jobId dedup nên enqueue
// trùng chỉ no-op, không tạo double refund.
@Injectable()
export class RefundQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundQueue.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectQueue('refund') private readonly queue: Queue,
    private readonly repository: PaymentRepository,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async enqueue(paymentId: string) {
    await this.queue.add(
      'refund',
      { paymentId },
      {
        // jobId cố định theo payment: re-enqueue khi job còn sống là no-op,
        // và 1 payment không bao giờ có 2 refund job song song.
        jobId: `refund-${paymentId}`,
        attempts: 8,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
      },
    );
  }

  // Intent đã ghi (refundRequestedAt) nhưng job có thể mất khi Redis flush
  // hoặc enqueue throw sau khi ghi DB → quét lại và re-enqueue.
  private async sweep() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const pending =
        await this.repository.findPendingRefunds(SWEEP_BATCH_SIZE);
      for (const payment of pending) {
        await this.enqueue(payment.id);
      }
      if (pending.length > 0) {
        this.logger.log(`Re-enqueued ${pending.length} pending refund(s)`);
      }
    } catch (error: unknown) {
      this.logger.error(`Refund sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

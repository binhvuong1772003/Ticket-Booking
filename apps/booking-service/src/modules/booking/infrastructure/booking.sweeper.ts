import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BookingService } from '../application/booking.service';

const SWEEP_BATCH_SIZE = 100;
const SWEEP_INTERVAL_MS = 30_000;

// ponytail: setInterval chạy trên mọi replica — multi-instance sẽ quét trùng
// (conditional update vẫn đúng, chỉ dư reads); BullMQ repeatable nếu cần dedup.
@Injectable()
export class BookingSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingSweeper.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly bookingService: BookingService) {}

  onModuleInit() {
    this.logger.log('Booking sweeper started');
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async sweep() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const expired = await this.bookingService.sweepExpiredBookings(
        new Date(),
        SWEEP_BATCH_SIZE,
      );
      if (expired > 0) {
        this.logger.log(`Expired ${expired} booking(s)`);
      }
      const refunded =
        await this.bookingService.sweepStuckRefunds(SWEEP_BATCH_SIZE);
      if (refunded > 0) {
        this.logger.log(`Retried refund for ${refunded} booking(s)`);
      }
    } catch (error: unknown) {
      this.logger.error(`Booking sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

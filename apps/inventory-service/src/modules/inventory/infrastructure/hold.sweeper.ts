import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InventoryRepository } from './inventory.repository';

const SWEEP_BATCH_SIZE = 100;
const SWEEP_INTERVAL_MS = 30_000;

// ponytail: setInterval chạy trên mọi replica — multi-instance sẽ quét trùng
// (conditional update vẫn đúng, chỉ dư reads); BullMQ repeatable nếu cần dedup.
@Injectable()
export class HoldSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HoldSweeper.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly inventoryRepository: InventoryRepository) {}

  onModuleInit() {
    this.logger.log('Hold sweeper started');
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
      const expired = await this.inventoryRepository.expireHolds(
        new Date(),
        SWEEP_BATCH_SIZE,
      );
      if (expired > 0) {
        this.logger.log(`Expired ${expired} hold(s)`);
      }
    } catch (error: unknown) {
      this.logger.error(`Hold sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}

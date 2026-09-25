import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { InventoryController } from './presentation/grpc/inventory.controller';
import { InventoryConsumer } from './presentation/messaging/inventory.consumer';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { HoldSweeper } from './infrastructure/hold.sweeper';
import { InventoryService } from './application/inventory.service';
import { TicketTypeCreatedHandler } from './application/handlers/ticket-type-created.handler';
import { TicketTypeUpdatedHandler } from './application/handlers/ticket-type-updated.handler';
import { TicketTypeDeletedHandler } from './application/handlers/ticket-type-deleted.handler';
import { SessionStatusChangedHandler } from './application/handlers/session-status-changed.handler';

@Module({
  imports: [PrismaModule],
  controllers: [InventoryController, InventoryConsumer],
  providers: [
    InventoryService,
    InventoryRepository,
    TicketTypeCreatedHandler,
    TicketTypeUpdatedHandler,
    TicketTypeDeletedHandler,
    SessionStatusChangedHandler,
    HoldSweeper,
  ],
})
export class InventoryServiceModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { InventoryController } from './presentation/grpc/inventory.controller';
import { InventoryConsumer } from './presentation/messaging/inventory.consumer';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { InventoryService } from './application/inventory.service';
import { TicketTypeCreatedHandler } from './application/handlers/ticket-type-created.handler';

@Module({
  imports: [PrismaModule],
  controllers: [InventoryController, InventoryConsumer],
  providers: [InventoryService, InventoryRepository, TicketTypeCreatedHandler],
})
export class InventoryServiceModule {}

import { Module } from '@nestjs/common';
import { InventoryServiceModule } from './modules/inventory/inventory.module';

@Module({
  imports: [InventoryServiceModule],
})
export class AppModule {}

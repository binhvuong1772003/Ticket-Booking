import { Module } from '@nestjs/common';
import { BookingModule } from './booking/booking.module.js';

@Module({
  imports: [BookingModule],
})
export class AppModule {}

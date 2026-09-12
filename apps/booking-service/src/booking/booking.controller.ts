import { Controller, Inject } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { BookingService } from './booking.service.js';

@Controller()
export class BookingController {
  constructor(
    @Inject(BookingService) private readonly bookingService: BookingService,
  ) {}

  @MessagePattern('booking.health')
  getHealth() {
    return this.bookingService.getHealth();
  }
}

import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  BookingService,
  CreateBookingMessage,
  ReserveResponse,
} from '../../application/booking.service.js';

@Controller()
export class BookingController {
  constructor(
    @Inject(BookingService) private readonly bookingService: BookingService,
  ) {}

  @MessagePattern('booking.health')
  getHealth() {
    return this.bookingService.getHealth();
  }

  @MessagePattern('booking.create')
  createBooking(
    @Payload() input: CreateBookingMessage,
  ): Promise<ReserveResponse> {
    return this.bookingService.reserveInventory(input);
  }
}

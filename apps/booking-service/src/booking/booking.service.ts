import { Injectable } from '@nestjs/common';

@Injectable()
export class BookingService {
  getHealth() {
    return { service: 'booking-service', status: 'ok' };
  }
}

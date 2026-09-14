import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailTemplate {
  welcome(name: string): string {
    return `
      <h1>Welcome ${name}</h1>
      <p>Your account has been created successfully.</p>
    `;
  }

  bookingConfirmed(customerName: string, bookingId: string): string {
    return `
      <h1>Booking confirmed</h1>

      <p>Hello ${customerName}</p>

      <p>
        Your booking ${bookingId} has been confirmed.
      </p>
    `;
  }
}

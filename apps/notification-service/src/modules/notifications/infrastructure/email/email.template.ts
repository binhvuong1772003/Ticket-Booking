import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailTemplate {
  verification(name: string, verifyURL: string): string {
    return `
    <h2>Hello ${name ?? ''} - Email Verification</h2>
    <p>Click the link below to verify your email:</p>
    <a href="${verifyURL}">${verifyURL}</a>
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

  refunded(
    customerName: string,
    bookingId: string,
    amount?: number | null,
    currency?: string | null,
  ): string {
    const amountText =
      amount != null && currency ? `${amount} ${currency.toUpperCase()}` : '';
    return `
      <h1>Refund issued</h1>

      <p>Hello ${customerName}</p>

      <p>
        Your booking ${bookingId} has been refunded${amountText ? ` — ${amountText}` : ''}.
        The amount will return to your original payment method.
      </p>
    `;
  }
}

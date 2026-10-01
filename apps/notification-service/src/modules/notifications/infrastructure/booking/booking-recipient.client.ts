import { Injectable } from '@nestjs/common';

export type BookingRecipient = {
  bookingId: string;
  ownerId: string;
  recipientFullName: string | null;
  recipientEmail: string | null;
};

@Injectable()
export class BookingRecipientClient {
  private readonly endpoint =
    process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql';

  async getRecipient(bookingId: string): Promise<BookingRecipient> {
    const token = process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    if (!token) throw new Error('Booking service authentication is not configured');
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-booking-service-token': token,
      },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        query: `query InternalBookingRecipient($bookingId: ID!) {
          internalBookingRecipient(bookingId: $bookingId) {
            bookingId ownerId recipientFullName recipientEmail
          }
        }`,
        variables: { bookingId },
      }),
    });
    if (!response.ok) throw new Error(`booking-service responded ${response.status}`);
    const body = (await response.json()) as {
      data?: { internalBookingRecipient?: BookingRecipient };
      errors?: unknown[];
    };
    const recipient = body.data?.internalBookingRecipient;
    if (body.errors?.length || !recipient?.bookingId || !recipient.ownerId) {
      throw new Error('booking recipient lookup failed');
    }
    return recipient;
  }
}

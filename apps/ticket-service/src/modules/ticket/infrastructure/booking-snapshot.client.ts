import { Injectable } from '@nestjs/common';

@Injectable()
export class BookingSnapshotClient {
  private readonly endpoint = process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql';

  async getTicketItemSnapshot(bookingItemId: string) {
    const token = process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    if (!token) throw new Error('Booking service authentication is not configured');
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-booking-service-token': token },
      body: JSON.stringify({
        query: `query TicketBookingItemSnapshot($bookingItemId: String!) {
          ticketBookingItemSnapshot(bookingItemId: $bookingItemId) { unitPriceMinor unitPrice currency }
        }`,
        variables: { bookingItemId },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`booking-service responded ${response.status}`);
    const body = await response.json() as {
      data?: { ticketBookingItemSnapshot?: { unitPriceMinor?: string | null; unitPrice?: string; currency?: string } };
      errors?: unknown[];
    };
    const snapshot = body.data?.ticketBookingItemSnapshot;
    if (body.errors?.length || !snapshot?.unitPrice || !snapshot.currency) {
      throw new Error('booking-service ticket item snapshot lookup failed');
    }
    return snapshot as { unitPriceMinor: string | null; unitPrice: string; currency: string };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { TicketRepository } from '../infrastructure/ticket.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { Prisma } from '../../../generated/ticket-prisma';
import { EventSnapshotClient } from '../infrastructure/event-snapshot.client';
import { BookingSnapshotClient } from '../infrastructure/booking-snapshot.client';

// Payload 'booking.confirmed' do OutboxProcessor của booking-service emit.
export type BookingConfirmedPayload = {
  booking_id?: string;
  user_id?: string;
  event_id?: string;
  session_id?: string;
  currency?: string;
  items?: {
    booking_item_id?: string;
    ticket_type_id?: string;
    ticket_type_name?: string;
    ticket_type_code?: string;
    unit_price_minor?: string | null;
    unit_price?: string | null;
    quantity?: number;
  }[];
};

type BookingConfirmedItem = NonNullable<BookingConfirmedPayload['items']>[number];

function unitPrice(item: BookingConfirmedItem, currency: string) {
  if (item.unit_price_minor != null) {
    if (!/^\d+$/.test(item.unit_price_minor)) {
      throw new Error('Invalid locked ticket price');
    }
    const fractionDigits = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Prisma.Decimal(item.unit_price_minor).div(
      new Prisma.Decimal(10).pow(fractionDigits),
    );
  }
  if (item.unit_price != null && /^\d+(?:\.\d+)?$/.test(item.unit_price)) {
    return new Prisma.Decimal(item.unit_price);
  }
  throw new Error('Missing or invalid locked ticket price');
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly ticketRepository: TicketRepository,
    private readonly outboxProcessor: OutboxProcessor,
    private readonly eventSnapshotClient: EventSnapshotClient,
    private readonly bookingSnapshotClient: BookingSnapshotClient,
  ) {}

  /* Cấp `quantity` vé mỗi booking item, ordinal 1..N. Idempotent qua
     @@unique([bookingItemId, ordinal]) + skipDuplicates — replay event
     (Kafka at-least-once) hoặc crash giữa chừng chỉ điền nốt vé còn thiếu. */
  async issueForBooking(payload: BookingConfirmedPayload) {
    const { booking_id, user_id, event_id, session_id, items } = payload;
    if (!booking_id || !user_id || !event_id || !session_id || !items?.length) {
      throw new Error('booking.confirmed missing required identifiers/items');
    }

    let currency = payload.currency?.toUpperCase() ?? '';
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid booking currency');
    }

    const validItems = items.map((item) => {
      if (
        !item.booking_item_id ||
        !item.ticket_type_id ||
        typeof item.quantity !== 'number' ||
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1
      ) {
        this.logger.warn(`booking.confirmed has an invalid item for ${booking_id}`);
        throw new Error('booking.confirmed contains an invalid item');
      }
      return item as BookingConfirmedItem & {
        booking_item_id: string;
        ticket_type_id: string;
        quantity: number;
      };
    });

    const pricedItems = await Promise.all(validItems.map(async (item) => {
      if (item.unit_price_minor != null || item.unit_price != null) {
        if (currency) return item;
      }
      const snapshot = await this.bookingSnapshotClient.getTicketItemSnapshot(
        item.booking_item_id,
      );
      const itemCurrency = snapshot.currency.toUpperCase();
      if (!/^[A-Z]{3}$/.test(itemCurrency) || (currency && currency !== itemCurrency)) {
        throw new Error('Booking item currency does not match booking currency');
      }
      currency ||= itemCurrency;
      return {
        ...item,
        unit_price_minor: item.unit_price_minor ?? snapshot.unitPriceMinor,
        unit_price: item.unit_price ?? snapshot.unitPrice,
      };
    }));

    const snapshot = await this.eventSnapshotClient.getTicketSnapshot(
      event_id,
      session_id,
    );

    const rows = pricedItems.flatMap((item) => {
      const eventActive =
        snapshot.eventStatus === 'PUBLISHED' &&
        snapshot.sessionStatus === 'SCHEDULED';
      return Array.from({ length: item.quantity }, (_, i) => ({
        bookingId: booking_id,
        bookingItemId: item.booking_item_id,
        ownerId: user_id,
        eventId: event_id,
        sessionId: session_id,
        ticketTypeId: item.ticket_type_id,
        ordinal: i + 1,
        ticketTypeName: item.ticket_type_name ?? '',
        ticketTypeCode: item.ticket_type_code ?? '',
        eventTitle: snapshot.eventTitle,
        posterImageUrl: snapshot.posterImageUrl,
        coverImageUrl: snapshot.coverImageUrl,
        venueName: snapshot.venueName,
        venueAddress: snapshot.venueAddress,
        startsAt: snapshot.startsAt,
        endsAt: snapshot.endsAt,
        timezone: snapshot.timezone,
        unitPrice: unitPrice(item, currency),
        currency,
        sessionVersion: snapshot.sessionVersion,
        templateVersion: 2,
        renderRevision: 1,
        status: eventActive ? ('ISSUED' as const) : ('VOIDED' as const),
        ...(!eventActive
          ? { voidedAt: new Date(), voidReason: 'Event or session is no longer active' }
          : {}),
      }));
    });
    if (rows.length === 0) {
      return;
    }

    const result = await this.ticketRepository.issueMany(rows);
    if (result.issued.length > 0) {
      // ticket.issued vừa ghi outbox — publish ngay, không chờ poll 30s.
      this.outboxProcessor.wake();
    }
    this.logger.log(
      `issued ${result.issued.length}/${rows.length} ticket(s) for booking ${booking_id}`,
    );
  }
}

import { Prisma, PrismaClient } from '../generated/ticket-prisma';
import { EventSnapshotClient } from '../modules/ticket/infrastructure/event-snapshot.client';
import { BookingSnapshotClient } from '../modules/ticket/infrastructure/booking-snapshot.client';

const prisma = new PrismaClient();
const events = new EventSnapshotClient();
const bookings = new BookingSnapshotClient();
const batchSize = 100;

async function backfill() {
  let cursor: string | undefined;
  let updated = 0;
  for (;;) {
    const rows = await prisma.ticket.findMany({
      where: { status: { not: 'VOIDED' }, OR: [{ eventTitle: null }, { unitPrice: null }, { currency: null }] },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    if (!rows.length) break;
    const eventSnapshots = new Map<string, Awaited<ReturnType<typeof events.getTicketSnapshot>>>();
    const bookingSnapshots = new Map<string, Awaited<ReturnType<typeof bookings.getTicketItemSnapshot>>>();
    for (const ticket of rows) {
      try {
        const eventKey = `${ticket.eventId}:${ticket.sessionId}`;
        const eventSnapshot = eventSnapshots.get(eventKey) ?? await events.getTicketSnapshot(ticket.eventId, ticket.sessionId);
        eventSnapshots.set(eventKey, eventSnapshot);
        const bookingSnapshot = bookingSnapshots.get(ticket.bookingItemId) ?? await bookings.getTicketItemSnapshot(ticket.bookingItemId);
        bookingSnapshots.set(ticket.bookingItemId, bookingSnapshot);
        const fractionDigits = new Intl.NumberFormat('en', {
          style: 'currency', currency: bookingSnapshot.currency,
        }).resolvedOptions().maximumFractionDigits ?? 2;
        const unitPrice = bookingSnapshot.unitPriceMinor != null
          ? new Prisma.Decimal(bookingSnapshot.unitPriceMinor).div(new Prisma.Decimal(10).pow(fractionDigits))
          : new Prisma.Decimal(bookingSnapshot.unitPrice);
        await prisma.ticket.updateMany({
          where: { id: ticket.id, OR: [{ eventTitle: null }, { unitPrice: null }, { currency: null }] },
          data: {
            eventTitle: eventSnapshot.eventTitle,
            posterImageUrl: eventSnapshot.posterImageUrl,
            coverImageUrl: eventSnapshot.coverImageUrl,
            venueName: eventSnapshot.venueName,
            venueAddress: eventSnapshot.venueAddress,
            startsAt: eventSnapshot.startsAt,
            endsAt: eventSnapshot.endsAt,
            timezone: eventSnapshot.timezone,
            sessionVersion: eventSnapshot.sessionVersion,
            unitPrice: ticket.unitPrice ?? unitPrice,
            currency: ticket.currency ?? bookingSnapshot.currency,
          },
        });
        updated++;
      } catch (error) {
        console.error(`ticket snapshot backfill failed for ${ticket.id}: ${(error as Error).name}`);
      }
    }
    cursor = rows.at(-1)!.id;
    console.log(`ticket snapshot backfill checkpoint=${cursor} updated=${updated}`);
  }
}

backfill().finally(() => prisma.$disconnect());

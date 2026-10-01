import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/ticket-prisma';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { TicketRepository } from '../src/modules/ticket/infrastructure/ticket.repository';

// Opt in with a dedicated migrated PostgreSQL database. Never fall back to DATABASE_URL.
const url = process.env.TICKET_TEST_DATABASE_URL;
if (url && url === process.env.DATABASE_URL) {
  throw new Error('TICKET_TEST_DATABASE_URL must be separate from DATABASE_URL');
}
const prisma = url ? new PrismaService({ datasourceUrl: url }) : null;
const lockClient = url ? new PrismaService({ datasourceUrl: url }) : null;
const repository = prisma ? new TicketRepository(prisma) : null;
const bookingIds: string[] = [];

describe.skipIf(!url)('ticket refund ordering (real PostgreSQL)', () => {
  const db = prisma!;
  const blocker = lockClient!;
  const repo = repository!;

  beforeAll(async () => {
    await Promise.all([db.$connect(), blocker.$connect()]);
  });

  afterAll(async () => {
    if (bookingIds.length) {
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: bookingIds } } });
      await db.ticket.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.bookingTicketState.deleteMany({ where: { bookingId: { in: bookingIds } } });
    }
    await Promise.all([db.$disconnect(), blocker.$disconnect()]);
  });

  function newBookingId() {
    const id = `refund-test-${randomUUID()}`;
    bookingIds.push(id);
    return id;
  }

  function ticket(bookingId: string): Prisma.TicketCreateManyInput {
    return {
      bookingId,
      bookingItemId: `${bookingId}-item`,
      ownerId: 'refund-test-user',
      eventId: 'refund-test-event',
      sessionId: 'refund-test-session',
      ticketTypeId: 'refund-test-type',
      ordinal: 1,
      ticketTypeName: 'Test ticket',
      ticketTypeCode: 'TEST',
      status: 'ISSUED',
    };
  }

  async function acquireTicketTableLock() {
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const transaction = blocker.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "tickets" IN ACCESS EXCLUSIVE MODE`;
      signalLocked();
      await released;
    }, { timeout: 15000 });
    await locked;
    return { release, transaction };
  }

  async function waitForBlockedQueries(...fragments: string[]) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiting = await blocker.$queryRaw<Array<{ query: string }>>`
        SELECT query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      if (fragments.every((fragment) => waiting.some(({ query }) => query.includes(fragment)))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for locked SQL: ${fragments.join(', ')}`);
  }

  it('serializes issue-first: refund voids the committed ticket and keeps its historical outbox event', async () => {
    const bookingId = newBookingId();
    const held = await acquireTicketTableLock();
    const issue = repo.issueMany([ticket(bookingId)]);
    let refund: ReturnType<typeof repo.voidTicketsForBooking> | undefined;
    try {
      await waitForBlockedQueries('INSERT INTO "tickets"');
      refund = repo.voidTicketsForBooking(bookingId, 'test refund');
      await waitForBlockedQueries('INSERT INTO "booking_ticket_states"');
    } finally {
      held.release();
      await held.transaction;
    }
    const [issued] = await Promise.all([issue, refund!]);
    await repo.voidTicketsForBooking(bookingId, 'later refund');

    expect(issued.issued).toHaveLength(1);
    expect(await db.bookingTicketState.findUniqueOrThrow({ where: { bookingId } })).toMatchObject({
      voidedAt: expect.any(Date), voidReason: 'test refund',
    });
    expect(await db.ticket.findMany({ where: { bookingId } })).toMatchObject([
      { status: 'VOIDED', credentialVersion: 2 },
    ]);
    expect(await db.outboxEvent.count({ where: { aggregateId: bookingId, type: 'ticket.issued' } })).toBe(1);
  });

  it('serializes refund-first: later confirmation creates no ticket or outbox event', async () => {
    const bookingId = newBookingId();
    const held = await acquireTicketTableLock();
    const refund = repo.voidTicketsForBooking(bookingId, 'test refund');
    let issue: ReturnType<typeof repo.issueMany> | undefined;
    try {
      await waitForBlockedQueries('UPDATE "tickets"');
      issue = repo.issueMany([ticket(bookingId)]);
      await waitForBlockedQueries('INSERT INTO "booking_ticket_states"');
    } finally {
      held.release();
      await held.transaction;
    }
    const [voided, issued] = await Promise.all([refund, issue!]);

    expect(voided.count).toBe(0);
    expect(issued.issued).toEqual([]);
    expect(await db.ticket.count({ where: { bookingId } })).toBe(0);
    expect(await db.outboxEvent.count({ where: { aggregateId: bookingId, type: 'ticket.issued' } })).toBe(0);
    expect((await db.bookingTicketState.findUniqueOrThrow({ where: { bookingId } })).voidedAt).toBeInstanceOf(Date);
  });

  it('rolls back booking state and tickets when writing ticket.issued fails', async () => {
    const bookingId = newBookingId();
    const constraint = `ticket_issued_abort_${randomUUID().replaceAll('-', '')}`;
    await blocker.$executeRawUnsafe(
      `ALTER TABLE "outbox_events" ADD CONSTRAINT "${constraint}" CHECK ("type" <> 'ticket.issued') NOT VALID`,
    );
    try {
      await expect(repo.issueMany([ticket(bookingId)])).rejects.toThrow();
      expect(await db.bookingTicketState.findUnique({ where: { bookingId } })).toBeNull();
      expect(await db.ticket.count({ where: { bookingId } })).toBe(0);
      expect(await db.outboxEvent.count({ where: { aggregateId: bookingId } })).toBe(0);
    } finally {
      await blocker.$executeRawUnsafe(
        `ALTER TABLE "outbox_events" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }
  });
});

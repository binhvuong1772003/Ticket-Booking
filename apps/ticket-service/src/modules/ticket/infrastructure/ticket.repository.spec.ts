import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TicketRepository } from './ticket.repository';

describe('TicketRepository.issueMany', () => {
  it('writes tickets and an ID-only outbox event in one transaction', async () => {
    const rows = [
      {
        id: 'ticket-1',
        bookingId: 'booking-1',
        bookingItemId: 'item-1',
        ownerId: 'user-1',
        eventId: 'event-1',
        sessionId: 'session-1',
        ticketTypeId: 'type-1',
        ordinal: 1,
        ticketTypeName: 'VIP',
        ticketTypeCode: 'VIP',
        credentialVersion: 1,
      },
    ];
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ voidedAt: null, voidReason: null }]),
      bookingTicketState: { update: vi.fn() },
      ticket: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue(rows),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const transaction = vi.fn((callback) => callback(tx));
    const repository = new TicketRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await repository.issueMany(rows as never);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.ticket.createMany).toHaveBeenCalledWith({
      data: rows,
      skipDuplicates: true,
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ticket.issued',
        aggregateId: 'booking-1',
        payload: {
          booking_id: 'booking-1',
          user_id: 'user-1',
          event_id: 'event-1',
          session_id: 'session-1',
          tickets: [{ ticket_id: 'ticket-1', ordinal: 1 }],
        },
      }),
    });
    const outboxPayload = tx.outboxEvent.create.mock.calls[0][0].data.payload;
    expect(JSON.stringify(outboxPayload)).not.toContain('qr_token');
  });

  it('does not emit an outbox event when every ticket already exists', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ voidedAt: null, voidReason: null }]),
      bookingTicketState: { update: vi.fn() },
      ticket: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn(),
      },
      outboxEvent: { create: vi.fn() },
    };
    const repository = new TicketRepository({
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaService);

    await repository.issueMany(
      [{ bookingId: 'booking-1' }] as never,
      () => 'unused',
    );

    expect(tx.ticket.findMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

describe('TicketRepository booking refund serialization', () => {
  const row = {
    bookingId: 'booking-1',
    bookingItemId: 'item-1',
    ownerId: 'user-1',
    eventId: 'event-1',
    sessionId: 'session-1',
    ticketTypeId: 'type-1',
    ordinal: 1,
    ticketTypeName: 'VIP',
    ticketTypeCode: 'VIP',
  };

  function transaction(state: { voidedAt: Date | null; voidReason: string | null }) {
    return {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([state]),
      bookingTicketState: { update: vi.fn().mockResolvedValue(state) },
      ticket: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([{
          id: 'ticket-1', bookingId: row.bookingId, ownerId: row.ownerId,
          eventId: row.eventId, sessionId: row.sessionId, ordinal: 1,
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
  }

  it('remembers a refund before booking.confirmed and does not create tickets or outbox', async () => {
    const refundedAt = new Date('2026-09-28T00:00:00Z');
    const tx = transaction({ voidedAt: refundedAt, voidReason: 'test refund' });
    const repository = new TicketRepository({
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaService);

    await expect(repository.issueMany([row] as never)).resolves.toEqual({ issued: [] });

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$executeRaw.mock.calls[0][0].join('')).toContain(
      'INSERT INTO "booking_ticket_states"',
    );
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual([row.bookingId]);
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual([row.bookingId]);
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('locks one booking at a time and rejects mixed-booking batches', async () => {
    const $transaction = vi.fn();
    const repository = new TicketRepository({ $transaction } as unknown as PrismaService);

    await expect(repository.issueMany([
      row,
      { ...row, bookingId: 'another-booking', bookingItemId: 'item-2' },
    ] as never)).rejects.toThrow('one booking');

    expect($transaction).not.toHaveBeenCalled();
  });

  it('preserves the first refund reason and timestamp on repeated refunds', async () => {
    const refundedAt = new Date('2026-09-28T00:00:00Z');
    const first = transaction({ voidedAt: null, voidReason: null });
    const repeated = transaction({ voidedAt: refundedAt, voidReason: 'first refund' });
    const $transaction = vi.fn()
      .mockImplementationOnce((callback) => callback(first))
      .mockImplementationOnce((callback) => callback(repeated));
    const repository = new TicketRepository({ $transaction } as unknown as PrismaService);

    await repository.voidTicketsForBooking(row.bookingId, 'first refund');
    await repository.voidTicketsForBooking(row.bookingId, 'later reason');

    expect(first.bookingTicketState.update).toHaveBeenCalledWith({
      where: { bookingId: row.bookingId },
      data: { voidedAt: expect.any(Date), voidReason: 'first refund' },
    });
    expect(repeated.bookingTicketState.update).not.toHaveBeenCalled();
    expect(repeated.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ voidedAt: refundedAt, voidReason: 'first refund' }),
    }));
    for (const tx of [first, repeated]) {
      expect(tx.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { bookingId: row.bookingId, status: { not: 'VOIDED' } },
        data: expect.objectContaining({ status: 'VOIDED', credentialVersion: { increment: 1 } }),
      }));
    }
  });
});

describe('TicketRepository.checkIn', () => {
  const input = {
    scannerId: 'scanner-1', sessionId: 'session-1', ticketId: '00000000-0000-4000-8000-000000000001',
    credentialVersion: 1, requestId: '00000000-0000-4000-8000-000000000002', requestHash: 'a'.repeat(64),
  };

  it('updates an issued ticket and writes its accepted log in one transaction', async () => {
    const tx = {
      checkInLog: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ result: 'ACCEPTED', ticketId: input.ticketId }),
      },
      scannerAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment-1' }) },
      ticket: {
        findUnique: vi.fn().mockResolvedValue({ status: 'ISSUED', sessionId: input.sessionId, credentialVersion: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const repository = new TicketRepository({
      $transaction: vi.fn((callback) => callback(tx)),
    } as unknown as PrismaService);
    await repository.checkIn(input);
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: input.ticketId, sessionId: 'session-1', status: 'ISSUED', credentialVersion: 1 },
      data: expect.objectContaining({ status: 'CHECKED_IN', checkedInBy: 'scanner-1' }),
    }));
    expect(tx.checkInLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ result: 'ACCEPTED', requestHash: 'a'.repeat(64) }) }));
  });

  it('rejects scanners without a live assignment before looking up the ticket', async () => {
    const tx = {
      checkInLog: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ result: 'FORBIDDEN' }) },
      scannerAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      ticket: { findUnique: vi.fn(), updateMany: vi.fn() },
    };
    const repository = new TicketRepository({ $transaction: vi.fn((callback) => callback(tx)) } as unknown as PrismaService);
    const result = await repository.checkIn(input);
    expect(result.result).toBe('FORBIDDEN');
    expect(tx.ticket.findUnique).not.toHaveBeenCalled();
    expect(tx.ticket.updateMany).not.toHaveBeenCalled();
  });
});

describe('TicketRepository.updateRescheduledTickets', () => {
  it('persists the fresh poster and increments render revision without rotating credentials', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new TicketRepository({ ticket: { updateMany } } as unknown as PrismaService);
    const snapshot = {
      eventTitle: 'Saigon Live', eventStatus: 'PUBLISHED' as const,
      posterImageUrl: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
      coverImageUrl: null, venueName: 'Hall', venueAddress: null,
      startsAt: new Date('2026-10-20T12:00:00.000Z'), endsAt: null,
      timezone: 'Asia/Ho_Chi_Minh', sessionVersion: 5, sessionStatus: 'SCHEDULED' as const,
    };

    await repository.updateRescheduledTickets('session-1', snapshot);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        sessionId: 'session-1', status: { not: 'VOIDED' },
        OR: [{ sessionVersion: null }, { sessionVersion: { lt: 5 } }],
      },
      data: expect.objectContaining({
        posterImageUrl: snapshot.posterImageUrl,
        coverImageUrl: null,
        sessionVersion: 5,
        renderRevision: { increment: 1 },
      }),
    });
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('credentialVersion');
  });
});

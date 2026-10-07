import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { Prisma } from '../../../generated/ticket-prisma';
import type { EventTicketSnapshot } from './event-snapshot.client';

@Injectable()
export class TicketRepository {
  constructor(private readonly prisma: PrismaService) {}

  /* Insert vé + ghi ticket.issued vào outbox trong cùng tx.
     createMany là 1 statement nên atomic; replay event → skipDuplicates
     count=0 → không ghi outbox trùng → notification không gửi lại email.
     createMany không trả id nên đọc lại theo bookingId để payload có
     ticket_id thật; qr_token do application cung cấp qua tokenize. */
  async issueMany(data: Prisma.TicketCreateManyInput[]) {
    if (data.length === 0) {
      return { issued: [] };
    }

    const bookingId = data[0]?.bookingId;
    if (!bookingId || data.some((ticket) => ticket.bookingId !== bookingId)) {
      throw new Error('issueMany accepts tickets from one booking');
    }

    return this.prisma.$transaction(async (tx) => {
      const bookingState = await this.lockBookingState(tx, bookingId);
      if (bookingState.voidedAt) {
        return { issued: [] };
      }

      const { count } = await tx.ticket.createMany({
        data,
        skipDuplicates: true,
      });
      if (count === 0) {
        return { issued: [] };
      }

      const tickets = await tx.ticket.findMany({
        where: { bookingId },
      });
      await tx.outboxEvent.create({
        data: {
          type: 'ticket.issued',
          aggregateId: bookingId,
          payload: {
            booking_id: bookingId,
            user_id: tickets[0].ownerId,
            event_id: tickets[0].eventId,
            session_id: tickets[0].sessionId,
            tickets: tickets.map((t) => ({
              ticket_id: t.id,
              ordinal: t.ordinal,
              template_version: t.templateVersion,
              render_revision: t.renderRevision,
            })),
          },
        },
      });
      return { issued: tickets };
    });
  }

  async checkIn(input: {
    scannerId: string;
    sessionId: string;
    ticketId: string | null;
    credentialVersion: number | null;
    requestId: string;
    gateId?: string;
    requestHash: string;
  }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.checkInLog.findUnique({
          where: { scannerId_requestId: { scannerId: input.scannerId, requestId: input.requestId } },
        });
        if (existing) return this.sameCheckIn(existing, input.requestHash);

        const assignment = await tx.scannerAssignment.findFirst({
          where: { userId: input.scannerId, sessionId: input.sessionId, revokedAt: null },
          select: { id: true },
        });
        if (!assignment) return this.createCheckInLog(tx, input, 'FORBIDDEN', null);
        if (!input.ticketId || input.credentialVersion == null) {
          return this.createCheckInLog(tx, input, 'INVALID_QR', null);
        }

        const ticket = await tx.ticket.findUnique({ where: { id: input.ticketId } });
        let result: 'ACCEPTED' | 'ALREADY_CHECKED_IN' | 'VOIDED' | 'WRONG_SESSION' | 'INVALID_QR';
        if (!ticket || ticket.credentialVersion !== input.credentialVersion) result = 'INVALID_QR';
        else if (ticket.sessionId !== input.sessionId) result = 'WRONG_SESSION';
        else if (ticket.status === 'VOIDED') result = 'VOIDED';
        else if (ticket.status === 'CHECKED_IN') result = 'ALREADY_CHECKED_IN';
        else {
          const changed = await tx.ticket.updateMany({
            where: {
              id: input.ticketId,
              sessionId: input.sessionId,
              status: 'ISSUED',
              credentialVersion: input.credentialVersion,
            },
            data: { status: 'CHECKED_IN', checkedInAt: new Date(), checkedInBy: input.scannerId },
          });
          if (changed.count === 1) result = 'ACCEPTED';
          else {
            const current = await tx.ticket.findUnique({ where: { id: input.ticketId } });
            result = current?.status === 'VOIDED'
              ? 'VOIDED'
              : current?.status === 'CHECKED_IN'
                ? 'ALREADY_CHECKED_IN'
                : 'INVALID_QR';
          }
        }
        return this.createCheckInLog(tx, input, result, input.ticketId);
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const existing = await this.prisma.checkInLog.findUnique({
        where: { scannerId_requestId: { scannerId: input.scannerId, requestId: input.requestId } },
      });
      if (!existing) throw error;
      return this.sameCheckIn(existing, input.requestHash);
    }
  }

  voidTicketsForBooking(bookingId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.lockBookingState(tx, bookingId);
      const voidedAt = state.voidedAt ?? new Date();
      const voidReason = state.voidReason ?? reason.slice(0, 240);

      if (!state.voidedAt) {
        await tx.bookingTicketState.update({
          where: { bookingId },
          data: { voidedAt, voidReason },
        });
      }

      return tx.ticket.updateMany({
        where: { bookingId, status: { not: 'VOIDED' } },
        data: {
          status: 'VOIDED',
          voidedAt,
          voidReason,
          credentialVersion: { increment: 1 },
        },
      });
    });
  }

  private async lockBookingState(tx: Prisma.TransactionClient, bookingId: string) {
    await tx.$executeRaw`
      INSERT INTO "booking_ticket_states" ("bookingId")
      VALUES (${bookingId})
      ON CONFLICT ("bookingId") DO NOTHING
    `;

    const states = await tx.$queryRaw<Array<{ voidedAt: Date | null; voidReason: string | null }>>`
      SELECT "voidedAt", "voidReason"
      FROM "booking_ticket_states"
      WHERE "bookingId" = ${bookingId}
      FOR UPDATE
    `;
    const state = states[0];
    if (!state) {
      throw new Error(`Booking ticket state was not created for ${bookingId}`);
    }
    return state;
  }

  voidTicketsForEvent(eventId: string, reason: string) {
    return this.prisma.ticket.updateMany({
      where: { eventId, status: { not: 'VOIDED' } },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.slice(0, 240), credentialVersion: { increment: 1 } },
    });
  }

  voidTicketsForSession(sessionId: string, reason: string) {
    return this.prisma.ticket.updateMany({
      where: { sessionId, status: { not: 'VOIDED' } },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason.slice(0, 240), credentialVersion: { increment: 1 } },
    });
  }

  updateRescheduledTickets(sessionId: string, snapshot: EventTicketSnapshot) {
    return this.prisma.ticket.updateMany({
      where: {
        sessionId,
        status: { not: 'VOIDED' },
        OR: [{ sessionVersion: null }, { sessionVersion: { lt: snapshot.sessionVersion } }],
      },
      data: {
        eventTitle: snapshot.eventTitle,
        posterImageUrl: snapshot.posterImageUrl,
        coverImageUrl: snapshot.coverImageUrl,
        venueName: snapshot.venueName,
        venueAddress: snapshot.venueAddress,
        startsAt: snapshot.startsAt,
        endsAt: snapshot.endsAt,
        timezone: snapshot.timezone,
        sessionVersion: snapshot.sessionVersion,
        renderRevision: { increment: 1 },
      },
    });
  }

  private createCheckInLog(tx: any, input: any, result: string, ticketId: string | null) {
    return tx.checkInLog.create({
      data: {
        requestId: input.requestId,
        scannerId: input.scannerId,
        ticketId,
        sessionId: input.sessionId,
        gateId: input.gateId,
        result,
        requestHash: input.requestHash,
      },
    });
  }

  private sameCheckIn(existing: { requestHash: string; result: string; ticketId: string | null }, requestHash: string) {
    if (existing.requestHash !== requestHash) throw new ConflictException('Check-in request ID was reused');
    return existing;
  }
}

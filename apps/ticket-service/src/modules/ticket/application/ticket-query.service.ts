import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TicketCredentialService } from './credential.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { Ticket } from '../../../generated/ticket-prisma';

const ticketIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TicketQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: TicketCredentialService,
  ) {}

  async listOwnedTickets(ownerId: string, cursor = '', limit = 20) {
    if (!ownerId || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('Invalid ticket page');
    }
    const after = cursor ? this.decodeCursor(cursor) : null;
    const tickets = await this.prisma.ticket.findMany({
      where: {
        ownerId,
        ...(after && {
          OR: [
            { issuedAt: { lt: after.issuedAt } },
            { issuedAt: after.issuedAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = tickets.length > limit;
    const items = tickets.slice(0, limit).map((ticket) => this.toSummary(ticket));
    return {
      items,
      nextCursor:
        hasMore && tickets[limit - 1]
          ? this.encodeCursor(tickets[limit - 1])
          : null,
    };
  }

  async getOwnedTicket(ownerId: string, ticketId: string) {
    if (!ticketIdPattern.test(ticketId)) throw new NotFoundException('Ticket not found');
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, ownerId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return this.toDetail(ticket);
  }

  async getTicketForDelivery(ticketId: string) {
    if (!ticketIdPattern.test(ticketId)) throw new NotFoundException('Ticket not found');
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return this.toDetail(ticket);
  }

  private toSummary(ticket: Ticket) {
    return {
      ticketId: ticket.id,
      bookingId: ticket.bookingId,
      ordinal: ticket.ordinal,
      status: ticket.status,
      issuedAt: ticket.issuedAt.toISOString(),
      eventTitle: ticket.eventTitle,
      startsAt: ticket.startsAt?.toISOString() ?? null,
      endsAt: ticket.endsAt?.toISOString() ?? null,
      timezone: ticket.timezone,
      ticketTypeName: ticket.ticketTypeName,
      ticketTypeCode: ticket.ticketTypeCode,
    };
  }

  private toDetail(ticket: Ticket) {
    if (
      !ticket.eventTitle ||
      !ticket.startsAt ||
      !ticket.timezone ||
      !ticket.ticketTypeName ||
      !ticket.ticketTypeCode ||
      !ticket.currency ||
      ticket.unitPrice == null
    ) {
      throw new ServiceUnavailableException({
        code: 'TICKET_PREPARING',
        message: 'Ticket snapshot is not ready',
      });
    }
    return {
      ...this.toSummary(ticket),
      posterImageUrl: ticket.posterImageUrl,
      coverImageUrl: ticket.coverImageUrl,
      venueName: ticket.venueName,
      venueAddress: ticket.venueAddress,
      unitPrice: String(ticket.unitPrice),
      currency: ticket.currency,
      templateVersion: ticket.templateVersion,
      renderRevision: ticket.renderRevision,
      qrToken:
        ticket.status === 'VOIDED'
          ? null
          : this.credentials.sign(ticket.id, ticket.credentialVersion),
    };
  }

  private encodeCursor(ticket: Pick<Ticket, 'issuedAt' | 'id'>) {
    return Buffer.from(`${ticket.issuedAt.toISOString()}|${ticket.id}`).toString(
      'base64url',
    );
  }

  private decodeCursor(cursor: string) {
    try {
      const decoded = Buffer.from(cursor, 'base64url').toString();
      const [timestamp, id, extra] = decoded.split('|');
      const issuedAt = new Date(timestamp);
      if (
        extra !== undefined ||
        !timestamp ||
        !id ||
        Number.isNaN(issuedAt.getTime()) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ) {
        throw new Error('bad cursor');
      }
      return { issuedAt, id };
    } catch {
      throw new BadRequestException('Invalid ticket cursor');
    }
  }
}

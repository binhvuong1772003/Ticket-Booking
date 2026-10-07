import { Controller, HttpException, UnauthorizedException } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { timingSafeEqual } from 'node:crypto';
import { TicketQueryService } from '../../application/ticket-query.service';
import { TicketRendererService } from '../../application/ticket-renderer.service';
import { TicketCheckInService } from '../../application/ticket-checkin.service';

@Controller()
export class TicketGrpcController {
  constructor(
    private readonly tickets: TicketQueryService,
    private readonly renderer: TicketRendererService,
    private readonly checkIn: TicketCheckInService,
  ) {}

  @GrpcMethod('TicketService', 'ListOwnedTickets')
  async listOwnedTickets(request: any, metadata: Metadata) {
    return this.rpc(async () => {
      this.authorize(metadata);
      const page = await this.tickets.listOwnedTickets(
        request.owner_id, request.cursor || '', request.limit || 20,
      );
      return { items: page.items.map((ticket) => this.rpcSummary(ticket)), next_cursor: page.nextCursor ?? '' };
    });
  }

  @GrpcMethod('TicketService', 'GetOwnedTicket')
  async getOwnedTicket(request: any, metadata: Metadata) {
    return this.rpc(async () => {
      this.authorize(metadata);
      const ticket = await this.tickets.getOwnedTicket(request.owner_id, request.ticket_id);
      return { ticket: this.rpcTicket(ticket) };
    });
  }

  @GrpcMethod('TicketService', 'GetTicketForDelivery')
  async getTicketForDelivery(request: any, metadata: Metadata) {
    return this.rpc(async () => {
      this.authorize(metadata);
      const ticket = await this.tickets.getTicketForDelivery(request.ticket_id);
      return { ticket: this.rpcTicket(ticket) };
    });
  }

  @GrpcMethod('TicketService', 'RenderTicketForDelivery')
  async renderTicketForDelivery(request: any, metadata: Metadata) {
    return this.rpc(async () => {
      this.authorize(metadata);
      const ticket = await this.tickets.getTicketForDelivery(request.ticket_id);
      return { png: await this.renderer.renderTicketPng(ticket as any) };
    });
  }

  @GrpcMethod('TicketService', 'CheckInTicket')
  async checkInTicket(request: any, metadata: Metadata) {
    return this.rpc(async () => {
      this.authorize(metadata, true);
      const result = await this.checkIn.checkInTicket({
        scannerId: request.scanner_id,
        sessionId: request.session_id,
        qrToken: request.qr_token,
        requestId: request.request_id,
        gateId: request.gate_id || undefined,
      });
      return { result: result.result, ticket_id: result.ticketId ?? '' };
    });
  }

  private async rpc<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const code = new Map<number, number>([
        [400, status.INVALID_ARGUMENT], [401, status.UNAUTHENTICATED],
        [403, status.PERMISSION_DENIED], [404, status.NOT_FOUND],
        [409, status.FAILED_PRECONDITION], [429, status.RESOURCE_EXHAUSTED],
        [503, status.UNAVAILABLE],
      ]).get(error.getStatus()) ?? status.INTERNAL;
      const response = error.getResponse();
      throw new RpcException({ code, message: error.message, details: JSON.stringify(response) });
    }
  }

  private authorize(metadata: Metadata, scannerCall = false) {
    const expected = scannerCall
      ? process.env.TICKET_CHECKIN_SERVICE_TOKEN
      : process.env.TICKET_INTERNAL_SERVICE_TOKEN;
    const supplied = metadata.get('x-ticket-service-token')[0];
    if (
      !expected ||
      typeof supplied !== 'string' ||
      Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      throw new UnauthorizedException('Invalid internal service token');
    }
  }

  private rpcSummary(ticket: any) {
    return {
      ticket_id: ticket.ticketId,
      booking_id: ticket.bookingId,
      ordinal: ticket.ordinal,
      status: ticket.status,
      issued_at: ticket.issuedAt,
      event_title: ticket.eventTitle ?? '',
      starts_at: ticket.startsAt ?? '',
      ends_at: ticket.endsAt ?? '',
      timezone: ticket.timezone ?? '',
      ticket_type_name: ticket.ticketTypeName,
      ticket_type_code: ticket.ticketTypeCode,
    };
  }

  private rpcTicket(ticket: any) {
    return {
      summary: this.rpcSummary(ticket),
      poster_image_url: ticket.posterImageUrl ?? '',
      cover_image_url: ticket.coverImageUrl ?? '',
      venue_name: ticket.venueName ?? '',
      venue_address: ticket.venueAddress ?? '',
      unit_price: ticket.unitPrice,
      currency: ticket.currency,
      template_version: ticket.templateVersion,
      render_revision: ticket.renderRevision,
      qr_token: ticket.qrToken ?? '',
    };
  }
}

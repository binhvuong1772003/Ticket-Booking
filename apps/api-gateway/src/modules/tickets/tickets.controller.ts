import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import type { Request, Response } from 'express';
import { firstValueFrom, type Observable } from 'rxjs';

type TicketRpc = {
  listOwnedTickets(input: object, metadata: Metadata): Observable<{ items: TicketSummaryRpc[]; next_cursor: string }>;
  getOwnedTicket(input: object, metadata: Metadata): Observable<{ ticket: TicketDetailRpc }>;
  renderTicketForDelivery(input: object, metadata: Metadata): Observable<{ png: Buffer }>;
  checkInTicket(input: object, metadata: Metadata): Observable<{ result: string; ticket_id: string }>;
};

type TicketSummaryRpc = {
  ticket_id: string; booking_id: string; ordinal: number; status: string; issued_at: string;
  event_title: string; starts_at: string; ends_at: string; timezone: string;
  ticket_type_name: string; ticket_type_code: string;
};
type TicketDetailRpc = {
  summary: TicketSummaryRpc; poster_image_url: string; cover_image_url: string; venue_name: string; venue_address: string;
  unit_price: string; currency: string; template_version: number; render_revision: number; qr_token: string;
};

type AuthenticatedRequest = Request & { user?: { sub: string } };

@Controller('tickets')
export class TicketsController {
  private tickets!: TicketRpc;

  constructor(@Inject('TICKET_SERVICE') private readonly grpc: ClientGrpc) {}

  onModuleInit() {
    this.tickets = this.grpc.getService<TicketRpc>('TicketService');
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor = '',
    @Query('limit') rawLimit?: string,
  ) {
    const ownerId = this.owner(request);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    const result = await this.call(() =>
      firstValueFrom(this.tickets.listOwnedTickets(
        { owner_id: ownerId, cursor, limit },
        this.metadata(),
      )),
    );
    return { items: result.items.map((ticket) => this.summary(ticket)), nextCursor: result.next_cursor || null };
  }

  @Get(':id')
  async detail(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const ownerId = this.owner(request);
    const result = await this.call(() =>
      firstValueFrom(this.tickets.getOwnedTicket(
        { owner_id: ownerId, ticket_id: id }, this.metadata(),
      )),
    );
    return this.toDetail(result.ticket);
  }

  @Get(':id/image')
  async image(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const ownerId = this.owner(request);
    await this.call(() =>
      firstValueFrom(this.tickets.getOwnedTicket(
        { owner_id: ownerId, ticket_id: id }, this.metadata(),
      )),
    );
    const image = await this.call(() =>
      firstValueFrom(this.tickets.renderTicketForDelivery({ ticket_id: id }, this.metadata())),
    );
    response.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="ticket-${id.replace(/[^0-9a-f-]/gi, '')}.png"`,
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
    }).send(Buffer.from(image.png));
  }

  @Post(':id/resend')
  @HttpCode(202)
  async resend(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const url = process.env.NOTIFICATION_SERVICE_URL;
    const token = process.env.NOTIFICATION_INTERNAL_SERVICE_TOKEN;
    if (!url || !token) throw new ServiceUnavailableException('Ticket email is unavailable');
    const response = await fetch(`${url.replace(/\/$/, '')}/internal/tickets/${encodeURIComponent(id)}/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notification-service-token': token },
      body: JSON.stringify({ ownerId: this.owner(request) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) throw new NotFoundException(body);
    if (response.status === 403) throw new ForbiddenException(body);
    if (response.status === 409) throw new ConflictException(body);
    if (response.status === 429) throw new HttpException(body, 429);
    if (!response.ok) throw new BadGatewayException(body);
    return body;
  }

  @Post('check-in')
  async checkIn(
    @Req() request: AuthenticatedRequest,
    @Body() body: { sessionId?: string; qrToken?: string; requestId?: string; gateId?: string },
  ) {
    const scannerId = this.owner(request);
    if (
      !body.sessionId || !body.qrToken || body.qrToken.length > 1024 ||
      !body.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)
    ) throw new BadRequestException('sessionId, qrToken and a UUID requestId are required');
    const token = process.env.TICKET_CHECKIN_SERVICE_TOKEN;
    if (!token) throw new ServiceUnavailableException('Ticket check-in is unavailable');
    const metadata = new Metadata();
    metadata.set('x-ticket-service-token', token);
    const result = await this.call(() => firstValueFrom(this.tickets.checkInTicket({
      scanner_id: scannerId,
      session_id: body.sessionId,
      qr_token: body.qrToken,
      request_id: body.requestId,
      gate_id: body.gateId ?? '',
    }, metadata)));
    return { result: result.result, ticketId: result.ticket_id || null };
  }

  private owner(request: AuthenticatedRequest) {
    if (!request.user?.sub) throw new UnauthorizedException('Authentication is required');
    return request.user.sub;
  }

  private summary(ticket: TicketSummaryRpc) {
    return {
      ticketId: ticket.ticket_id,
      bookingId: ticket.booking_id,
      ordinal: ticket.ordinal,
      status: ticket.status,
      issuedAt: ticket.issued_at,
      eventTitle: ticket.event_title,
      startsAt: ticket.starts_at || null,
      endsAt: ticket.ends_at || null,
      timezone: ticket.timezone,
      ticketTypeName: ticket.ticket_type_name,
      ticketTypeCode: ticket.ticket_type_code,
    };
  }

  private toDetail(ticket: TicketDetailRpc) {
    return {
      ...this.summary(ticket.summary),
      posterImageUrl: ticket.poster_image_url || null,
      coverImageUrl: ticket.cover_image_url || null,
      venueName: ticket.venue_name || null,
      venueAddress: ticket.venue_address || null,
      unitPrice: ticket.unit_price,
      currency: ticket.currency,
      templateVersion: ticket.template_version,
      renderRevision: ticket.render_revision,
      qrToken: ticket.qr_token || null,
    };
  }

  private metadata() {
    const token = process.env.TICKET_INTERNAL_SERVICE_TOKEN;
    if (!token) throw new ServiceUnavailableException('Ticket service is unavailable');
    const metadata = new Metadata();
    metadata.set('x-ticket-service-token', token);
    return metadata;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const code = (error as { code?: number }).code;
      const details = (error as { details?: string }).details;
      let serviceDetails: unknown = details;
      if (details) {
        try { serviceDetails = JSON.parse(details); } catch { /* retain gRPC details */ }
      }
      if (code === 5) throw new NotFoundException('Ticket not found');
      if (code === 3) throw new BadRequestException('Invalid ticket request');
      if (code === 9) throw new ConflictException(serviceDetails);
      if (code === 14) throw new ServiceUnavailableException(serviceDetails ?? 'Ticket service is unavailable');
      throw new BadGatewayException('Ticket service request failed');
    }
  }
}

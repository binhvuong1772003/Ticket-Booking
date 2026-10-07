import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';

export type TicketDelivery = {
  ticketId: string;
  bookingId: string;
  status: 'ISSUED' | 'CHECKED_IN' | 'VOIDED';
  eventTitle: string;
  ticketTypeName: string;
  ticketTypeCode: string;
  qrToken: string | null;
  templateVersion: number;
};

type TicketDetailRpc = {
  summary: {
    ticket_id: string; booking_id: string; status: TicketDelivery['status']; event_title: string;
    ticket_type_name: string; ticket_type_code: string;
  };
  qr_token: string;
  template_version: number;
};

type TicketRpc = {
  getOwnedTicket(input: object, metadata: Metadata): Observable<{ ticket: TicketDetailRpc }>;
  getTicketForDelivery(input: object, metadata: Metadata): Observable<{ ticket: TicketDetailRpc }>;
  renderTicketForDelivery(input: object, metadata: Metadata): Observable<{ png: Buffer }>;
};

@Injectable()
export class TicketClient implements OnModuleInit {
  private tickets!: TicketRpc;

  constructor(@Inject('TICKET_GRPC') private readonly grpc: ClientGrpc) {}

  onModuleInit() {
    this.tickets = this.grpc.getService<TicketRpc>('TicketService');
  }

  async getOwnedTicket(ownerId: string, ticketId: string) {
    const response = await firstValueFrom(this.tickets.getOwnedTicket(
      { owner_id: ownerId, ticket_id: ticketId }, this.metadata(),
    ).pipe(timeout(10_000)));
    return this.fromRpc(response.ticket);
  }

  async getTicket(ticketId: string) {
    const response = await firstValueFrom(this.tickets.getTicketForDelivery(
      { ticket_id: ticketId }, this.metadata(),
    ).pipe(timeout(10_000)));
    return this.fromRpc(response.ticket);
  }

  async render(ticketId: string) {
    const response = await firstValueFrom(this.tickets.renderTicketForDelivery(
      { ticket_id: ticketId }, this.metadata(),
    ).pipe(timeout(10_000)));
    return Buffer.from(response.png);
  }

  private metadata() {
    const token = process.env.TICKET_INTERNAL_SERVICE_TOKEN;
    if (!token) throw new Error('Ticket service authentication is not configured');
    const metadata = new Metadata();
    metadata.set('x-ticket-service-token', token);
    return metadata;
  }

  private fromRpc(ticket: TicketDetailRpc): TicketDelivery {
    return {
      ticketId: ticket.summary.ticket_id,
      bookingId: ticket.summary.booking_id,
      status: ticket.summary.status,
      eventTitle: ticket.summary.event_title,
      ticketTypeName: ticket.summary.ticket_type_name,
      ticketTypeCode: ticket.summary.ticket_type_code,
      qrToken: ticket.qr_token || null,
      templateVersion: ticket.template_version,
    };
  }
}

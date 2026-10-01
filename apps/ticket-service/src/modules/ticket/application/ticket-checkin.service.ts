import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TicketCredentialService } from './credential.service';
import { TicketRepository } from '../infrastructure/ticket.repository';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TicketCheckInService {
  constructor(
    private readonly credentials: TicketCredentialService,
    private readonly tickets: TicketRepository,
  ) {}

  checkInTicket(input: {
    scannerId: string;
    sessionId: string;
    qrToken: string;
    requestId: string;
    gateId?: string;
  }) {
    if (!input.scannerId || !input.sessionId || !uuid.test(input.requestId)) {
      throw new ConflictException('Invalid check-in request');
    }
    if (input.qrToken.length > 1024) throw new ConflictException('Invalid check-in request');
    const credential = this.credentials.verify(input.qrToken);
    const validCredential = credential && uuid.test(credential.ticketId) ? credential : null;
    const requestHash = createHash('sha256')
      .update(`${input.qrToken}\n${input.sessionId}\n${input.gateId ?? ''}`)
      .digest('hex');
    return this.tickets.checkIn({
      scannerId: input.scannerId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      gateId: input.gateId,
      ticketId: validCredential?.ticketId ?? null,
      credentialVersion: validCredential?.credentialVersion ?? null,
      requestHash,
    });
  }
}

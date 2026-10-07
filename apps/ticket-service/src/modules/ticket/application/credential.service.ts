import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/* Credential = "<ticketId>.<credentialVersion>.<hmac-sha256>", ký bằng
   TICKET_SECRET riêng của ticket-service. Không lưu token — verify bằng
   re-sign + timingSafeEqual rồi so credentialVersion với DB (rotate
   credentialVersion++ làm mọi token cũ chết). Notification chỉ forward
   opaque string, không cần secret. */
@Injectable()
export class TicketCredentialService {
  private readonly secret: string;

  constructor() {
    const secret = process.env.TICKET_SECRET;
    if (!secret) {
      throw new Error('TICKET_SECRET is required');
    }
    this.secret = secret;
  }

  sign(ticketId: string, credentialVersion: number): string {
    const payload = `${ticketId}.${credentialVersion}`;
    const signature = createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  verify(
    token: string,
  ): { ticketId: string; credentialVersion: number } | null {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [ticketId, versionStr] = parts;
    const credentialVersion = Number(versionStr);
    if (!ticketId || !Number.isInteger(credentialVersion)) {
      return null;
    }
    const expected = this.sign(ticketId, credentialVersion);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }
    return { ticketId, credentialVersion };
  }
}

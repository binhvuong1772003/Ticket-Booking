import { describe, expect, it, vi } from 'vitest';
import { TicketCredentialService } from './credential.service';

vi.stubEnv('TICKET_SECRET', 'test-secret');

describe('TicketCredentialService', () => {
  const service = new TicketCredentialService();

  it('sign → verify roundtrip', () => {
    const token = service.sign('ticket-uuid', 1);
    expect(service.verify(token)).toEqual({
      ticketId: 'ticket-uuid',
      credentialVersion: 1,
    });
  });

  it('rejects tampered or malformed tokens', () => {
    const token = service.sign('ticket-uuid', 1);
    expect(service.verify(`${token}x`)).toBeNull();
    expect(service.verify('not-a-token')).toBeNull();
    expect(service.verify('ticket-uuid.2.' + token.split('.')[2])).toBeNull();
  });
});

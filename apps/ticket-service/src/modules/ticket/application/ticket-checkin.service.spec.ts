import { describe, expect, it, vi } from 'vitest';
import { TicketCheckInService } from './ticket-checkin.service';

describe('TicketCheckInService', () => {
  it('passes only verified credentials to the atomic check-in repository', async () => {
    const checkIn = vi.fn().mockResolvedValue({ result: 'ACCEPTED' });
    const service = new TicketCheckInService(
      { verify: vi.fn().mockReturnValue({ ticketId: '00000000-0000-4000-8000-000000000001', credentialVersion: 3 }) } as any,
      { checkIn } as any,
    );
    await service.checkInTicket({
      scannerId: 'scanner-1', sessionId: 'session-1',
      qrToken: 'signed-credential', requestId: '00000000-0000-4000-8000-000000000002',
    });
    expect(checkIn.mock.calls[0][0]).toMatchObject({
      scannerId: 'scanner-1',
      sessionId: 'session-1',
      ticketId: '00000000-0000-4000-8000-000000000001',
      credentialVersion: 3,
    });
    expect(checkIn.mock.calls[0][0].requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(checkIn.mock.calls[0][0].requestHash).not.toContain('signed-credential');
  });

  it('treats an invalid signature as INVALID_QR without querying an untrusted ticket id', async () => {
    const checkIn = vi.fn().mockResolvedValue({ result: 'INVALID_QR' });
    const service = new TicketCheckInService({ verify: vi.fn().mockReturnValue(null) } as any, { checkIn } as any);
    await service.checkInTicket({
      scannerId: 'scanner-1', sessionId: 'session-1', qrToken: 'bad',
      requestId: '00000000-0000-4000-8000-000000000002',
    });
    expect(checkIn.mock.calls[0][0]).toMatchObject({ ticketId: null, credentialVersion: null });
  });
});

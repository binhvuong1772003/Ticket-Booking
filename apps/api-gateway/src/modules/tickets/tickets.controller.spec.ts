import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { TicketsController } from './tickets.controller';

const summary = {
  ticket_id: 'ticket-a', booking_id: 'booking-a', ordinal: 1, status: 'ISSUED',
  issued_at: '2026-09-28T00:00:00.000Z', event_title: 'Show', starts_at: '2026-10-01T00:00:00.000Z',
  ends_at: '', timezone: 'Asia/Ho_Chi_Minh', ticket_type_name: 'VIP', ticket_type_code: 'VIP',
};
const detail = {
  summary, poster_image_url: 'https://res.cloudinary.com/ticketgo/image/upload/poster.png',
  cover_image_url: '', venue_name: 'Hall', venue_address: '', unit_price: '800000',
  currency: 'VND', template_version: 1, render_revision: 1, qr_token: 'secret-token',
};

describe('TicketsController', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('takes owner identity from the verified request and maps a private detail', async () => {
    vi.stubEnv('TICKET_INTERNAL_SERVICE_TOKEN', 'service-token');
    const getOwnedTicket = vi.fn().mockReturnValue(of({ ticket: detail }));
    const controller = new TicketsController({ getService: () => ({ getOwnedTicket }) } as any);
    controller.onModuleInit();
    const response = await controller.detail({ user: { sub: 'user-a' } } as any, 'ticket-a');
    expect(getOwnedTicket.mock.calls[0][0]).toEqual({ owner_id: 'user-a', ticket_id: 'ticket-a' });
    expect(response.qrToken).toBe('secret-token');
    expect(response.posterImageUrl).toContain('poster.png');
    await expect(controller.detail({} as any, 'ticket-a')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns only ticket summaries in a list and validates the page size', async () => {
    vi.stubEnv('TICKET_INTERNAL_SERVICE_TOKEN', 'service-token');
    const listOwnedTickets = vi.fn().mockReturnValue(of({ items: [summary], next_cursor: '' }));
    const controller = new TicketsController({ getService: () => ({ listOwnedTickets }) } as any);
    controller.onModuleInit();
    const result = await controller.list({ user: { sub: 'user-a' } } as any, '', undefined);
    expect(result.items[0]).not.toHaveProperty('qrToken');
    expect(listOwnedTickets.mock.calls[0][0]).toMatchObject({ owner_id: 'user-a', limit: 20 });
    await expect(controller.list({ user: { sub: 'user-a' } } as any, '', '101')).rejects.toThrow('between 1 and 100');
  });

  it('checks ownership before rendering a private no-store PNG', async () => {
    vi.stubEnv('TICKET_INTERNAL_SERVICE_TOKEN', 'service-token');
    const calls: string[] = [];
    const controller = new TicketsController({ getService: () => ({
      getOwnedTicket: vi.fn(() => { calls.push('owner'); return of({ ticket: detail }); }),
      renderTicketForDelivery: vi.fn(() => { calls.push('render'); return of({ png: Buffer.from('png') }); }),
    }) } as any);
    controller.onModuleInit();
    const headers: Record<string, string> = {};
    const response = { set: (values: Record<string, string>) => { Object.assign(headers, values); return response; }, send: vi.fn() } as any;
    await controller.image({ user: { sub: 'user-a' } } as any, 'ticket-a', response);
    expect(calls).toEqual(['owner', 'render']);
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(response.send).toHaveBeenCalledWith(Buffer.from('png'));
  });

  it('uses the authenticated scanner identity for check-in', async () => {
    vi.stubEnv('TICKET_CHECKIN_SERVICE_TOKEN', 'scanner-service-token');
    const checkInTicket = vi.fn().mockReturnValue(of({ result: 'ACCEPTED', ticket_id: 'ticket-a' }));
    const controller = new TicketsController({ getService: () => ({ checkInTicket }) } as any);
    controller.onModuleInit();
    const result = await controller.checkIn({ user: { sub: 'scanner-1' } } as any, {
      sessionId: 'session-1', qrToken: 'signed-credential', requestId: '00000000-0000-4000-8000-000000000002',
    });
    expect(checkInTicket.mock.calls[0][0]).toMatchObject({ scanner_id: 'scanner-1', session_id: 'session-1' });
    expect(checkInTicket.mock.calls[0][1].get('x-ticket-service-token')).toEqual(['scanner-service-token']);
    expect(result).toEqual({ result: 'ACCEPTED', ticketId: 'ticket-a' });
    vi.stubEnv('TICKET_CHECKIN_SERVICE_TOKEN', '');
    await expect(controller.checkIn({ user: { sub: 'scanner-1' } } as any, {
      sessionId: 'session-1', qrToken: 'signed-credential', requestId: '00000000-0000-4000-8000-000000000002',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.checkIn({} as any, {
      sessionId: 'session-1', qrToken: 'credential', requestId: '00000000-0000-4000-8000-000000000002',
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

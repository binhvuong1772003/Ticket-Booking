import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TicketEmailClient } from './ticket-email.client';

describe('TicketEmailClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('queues a resend using the server supplied owner and internal token', async () => {
    vi.stubEnv('NOTIFICATION_SERVICE_URL', 'http://notification:4004/');
    vi.stubEnv('NOTIFICATION_INTERNAL_SERVICE_TOKEN', 'internal-secret');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deliveryId: 'delivery-1', status: 'queued' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new TicketEmailClient().resend('owner-1', 'ticket/id')).resolves.toEqual({ deliveryId: 'delivery-1', status: 'queued' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://notification:4004/internal/tickets/ticket%2Fid/resend',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-notification-service-token': 'internal-secret' },
        body: JSON.stringify({ ownerId: 'owner-1' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('fails closed when configuration is missing', async () => {
    await expect(new TicketEmailClient().resend('owner-1', 'ticket-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    [403, ForbiddenException], [404, NotFoundException], [409, ConflictException], [429, HttpException],
    [503, ServiceUnavailableException],
  ] as const)('maps upstream %i without exposing its body', async (status, exception) => {
    vi.stubEnv('NOTIFICATION_SERVICE_URL', 'http://notification:4004');
    vi.stubEnv('NOTIFICATION_INTERNAL_SERVICE_TOKEN', 'secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private upstream detail', { status })));
    await expect(new TicketEmailClient().resend('owner-1', 'ticket-1')).rejects.toBeInstanceOf(exception);
  });

  it('maps network errors and timeouts to service unavailable', async () => {
    vi.stubEnv('NOTIFICATION_SERVICE_URL', 'http://notification:4004');
    vi.stubEnv('NOTIFICATION_INTERNAL_SERVICE_TOKEN', 'secret');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')));
    await expect(new TicketEmailClient().resend('owner-1', 'ticket-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects malformed successful responses', async () => {
    vi.stubEnv('NOTIFICATION_SERVICE_URL', 'http://notification:4004');
    vi.stubEnv('NOTIFICATION_INTERNAL_SERVICE_TOKEN', 'secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"queued"}', { status: 202 })));
    await expect(new TicketEmailClient().resend('owner-1', 'ticket-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

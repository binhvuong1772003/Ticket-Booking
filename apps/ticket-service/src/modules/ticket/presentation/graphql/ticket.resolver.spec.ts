import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../../../../common/auth/jwt-auth.guard';
import { TicketResolver } from './ticket.resolver';

describe('JwtAuthGuard', () => {
  const execution = (request: any) => ({
    getType: () => 'graphql', getHandler: vi.fn(), getClass: vi.fn(),
    getArgs: () => [{}, {}, { req: request }, {}],
  }) as any;

  it('rejects missing, expired, and subjectless tokens', () => {
    const expired = new JwtAuthGuard({ verify: vi.fn(() => { throw new Error('expired'); }) } as any);
    expect(() => expired.canActivate(execution({ headers: {} }))).toThrow(UnauthorizedException);
    expect(() => expired.canActivate(execution({ headers: { authorization: 'Bearer expired' } }))).toThrow(UnauthorizedException);
    const subjectless = new JwtAuthGuard({ verify: vi.fn(() => ({ sub: '' })) } as any);
    expect(() => subjectless.canActivate(execution({ headers: { authorization: 'Bearer valid' } }))).toThrow(UnauthorizedException);
  });

  it('sets only the verified JWT payload on the request', () => {
    const request = { headers: { authorization: 'Bearer valid' } };
    const guard = new JwtAuthGuard({ verify: vi.fn(() => ({ sub: 'user-1' })) } as any);
    expect(guard.canActivate(execution(request))).toBe(true);
    expect(request.user).toEqual({ sub: 'user-1' });
  });
});

describe('TicketResolver', () => {
  const setup = () => {
    const queries = { listOwnedTickets: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), getOwnedTicket: vi.fn() };
    const checkIn = { checkInTicket: vi.fn().mockResolvedValue({ result: 'ACCEPTED', ticketId: 'ticket-1' }) };
    const email = { resend: vi.fn().mockResolvedValue({ deliveryId: 'delivery-1', status: 'queued' }) };
    return { resolver: new TicketResolver(queries as any, checkIn as any, email as any), queries, checkIn, email };
  };
  const context = { req: { user: { sub: 'user-1' } } } as any;

  it('uses the verified subject as owner and scanner identity', async () => {
    const { resolver, queries, checkIn } = setup();
    expect(await resolver.myTickets(20, null, context)).toEqual({ items: [], nextCursor: null });
    expect(queries.listOwnedTickets).toHaveBeenCalledWith('user-1', '', 20);
    await resolver.checkInTicket({ sessionId: 'session-1', qrToken: 'qr', requestId: '00000000-0000-4000-8000-000000000001' }, context);
    expect(checkIn.checkInTicket).toHaveBeenCalledWith(expect.objectContaining({ scannerId: 'user-1', sessionId: 'session-1' }));
  });

  it.each([0, 101, null])('rejects invalid first=%s', async (first) => {
    const { resolver } = setup();
    expect(() => resolver.myTickets(first as any, null, context)).toThrow(GraphQLError);
  });

  it('maps malformed cursors and hides foreign tickets as NOT_FOUND', async () => {
    const { resolver, queries } = setup();
    queries.listOwnedTickets.mockRejectedValue(new BadRequestException('bad cursor'));
    await expect(resolver.myTickets(20, 'bad', context)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    queries.getOwnedTicket.mockRejectedValue(new NotFoundException());
    await expect(resolver.myTicket('foreign', context)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('preserves void QR null and maps incomplete snapshots to TICKET_PREPARING', async () => {
    const { resolver, queries } = setup();
    const detail = { ticketId: 'ticket-1', status: 'VOIDED', qrToken: null };
    queries.getOwnedTicket.mockResolvedValue(detail);
    expect(await resolver.myTicket('ticket-1', context)).toBe(detail);
    queries.getOwnedTicket.mockRejectedValue(new ServiceUnavailableException({ code: 'TICKET_PREPARING' }));
    await expect(resolver.myTicket('ticket-1', context)).rejects.toMatchObject({ extensions: { code: 'TICKET_PREPARING' } });
  });

  it('forwards resend through the server-derived owner and maps notification errors', async () => {
    const { resolver, email } = setup();
    expect(await resolver.resendTicketEmail('ticket-1', context)).toEqual({ deliveryId: 'delivery-1', status: 'queued' });
    expect(email.resend).toHaveBeenCalledWith('user-1', 'ticket-1');
    const failures: Array<[Error, string]> = [
      [new ForbiddenException(), 'FORBIDDEN'], [new ConflictException(), 'CONFLICT'],
      [new HttpException('cooldown', 429), 'TOO_MANY_REQUESTS'],
      [new ServiceUnavailableException(), 'SERVICE_UNAVAILABLE'],
    ];
    for (const [error, code] of failures) {
      email.resend.mockRejectedValueOnce(error);
      await expect(resolver.resendTicketEmail('ticket-1', context)).rejects.toMatchObject({ extensions: { code } });
    }
  });

  it('rejects forged identity fields in check-in input', async () => {
    const { resolver } = setup();
    expect(() => resolver.checkInTicket({ ownerId: 'forged', scannerId: 'forged' } as any, context)).toThrow(GraphQLError);
  });

  it.each([
    { sessionId: '', qrToken: 'qr', requestId: '00000000-0000-4000-8000-000000000001' },
    { sessionId: 'session-1', qrToken: 'x'.repeat(1025), requestId: '00000000-0000-4000-8000-000000000001' },
    { sessionId: 'session-1', qrToken: 'qr', requestId: 'bad' },
    { sessionId: 'session-1', qrToken: 'qr', requestId: '00000000-0000-4000-8000-000000000001', gateId: 123 },
  ])('rejects invalid check-in input %#', ({ sessionId, qrToken, requestId, gateId }) => {
    const { resolver } = setup();
    expect(() => resolver.checkInTicket({ sessionId, qrToken, requestId, gateId } as any, context)).toThrow(GraphQLError);
  });
});

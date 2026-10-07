import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { TicketResolver } from '../src/modules/ticket/presentation/graphql/ticket.resolver';
import { JwtAuthGuard } from '../src/common/auth/jwt-auth.guard';
import { TicketQueryService } from '../src/modules/ticket/application/ticket-query.service';
import { TicketCheckInService } from '../src/modules/ticket/application/ticket-checkin.service';
import { TicketEmailClient } from '../src/modules/ticket/infrastructure/ticket-email.client';

const tickets = {
  listOwnedTickets: vi.fn(),
  getOwnedTicket: vi.fn(),
};
const checkIn = { checkInTicket: vi.fn() };
const email = { resend: vi.fn() };

const ticketId = '00000000-0000-4000-8000-000000000001';
const detail = {
  ticketId,
  bookingId: '00000000-0000-4000-8000-000000000002',
  ordinal: 1,
  status: 'ISSUED',
  issuedAt: '2026-10-01T00:00:00.000Z',
  eventTitle: null,
  startsAt: null,
  endsAt: null,
  timezone: null,
  ticketTypeName: 'Runner',
  ticketTypeCode: 'RUN03',
  posterImageUrl: null,
  coverImageUrl: null,
  venueName: null,
  venueAddress: null,
  unitPrice: '100000',
  currency: 'VND',
  templateVersion: 2,
  renderRevision: 1,
  qrToken: null,
};

describe('ticket Federation HTTP boundary', () => {
  let app: INestApplication;
  let url: string;
  let jwt: JwtService;
  let authorization: string;

  async function query(source: string, variables?: Record<string, unknown>, bearer = authorization) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: bearer } : {}),
      },
      body: JSON.stringify({ query: source, variables }),
    });
    return response.json() as Promise<{ data?: Record<string, any>; errors?: Array<{ extensions?: { code?: string } }> }>;
  }

  beforeAll(async () => {
    class TestModule {}
    Module({
      imports: [
        JwtModule.register({ secret: 'ticket-graphql-test-secret' }),
        GraphQLModule.forRoot<ApolloFederationDriverConfig>({
          driver: ApolloFederationDriver,
          autoSchemaFile: { federation: 2 },
          context: ({ req }: { req: any }) => ({ req }),
        }),
      ],
      providers: [
        TicketResolver,
        JwtAuthGuard,
        { provide: TicketQueryService, useValue: tickets },
        { provide: TicketCheckInService, useValue: checkIn },
        { provide: TicketEmailClient, useValue: email },
      ],
    })(TestModule);
    app = await NestFactory.create(TestModule, { logger: false });
    const server = await app.listen(0, '127.0.0.1');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
    url = `http://127.0.0.1:${address.port}/graphql`;
    jwt = app.get(JwtService);
    authorization = `Bearer ${jwt.sign({ sub: 'owner-1' })}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    tickets.listOwnedTickets.mockResolvedValue({ items: [], nextCursor: null });
    tickets.getOwnedTicket.mockResolvedValue(detail);
    email.resend.mockResolvedValue({ deliveryId: 'delivery-1', status: 'queued' });
    checkIn.checkInTicket.mockResolvedValue({ result: 'ACCEPTED', ticketId });
  });

  it('builds a public Federation schema but verifies JWT for ticket reads', async () => {
    expect((await query('{ __typename }', undefined, '')).data?.__typename).toBe('Query');
    const denied = await query('{ myTickets { nextCursor } }', undefined, '');
    expect(denied.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(tickets.listOwnedTickets).not.toHaveBeenCalled();

    const expired = `Bearer ${jwt.sign({ sub: 'owner-1', exp: Math.floor(Date.now() / 1000) - 60 })}`;
    expect((await query('{ myTickets { nextCursor } }', undefined, expired)).errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');

    const page = await query('query ($first: Int, $after: String) { myTickets(first: $first, after: $after) { items { ticketId } nextCursor } }', { first: 20, after: null });
    expect(page.errors).toBeUndefined();
    expect(page.data?.myTickets).toEqual({ items: [], nextCursor: null });
    expect(tickets.listOwnedTickets).toHaveBeenCalledWith('owner-1', '', 20);
  });

  it('rejects invalid pagination and never accepts a caller-supplied owner', async () => {
    for (const first of [0, 101, null]) {
      const result = await query('query ($first: Int) { myTickets(first: $first) { nextCursor } }', { first });
      expect(result.errors?.[0]?.extensions?.code, JSON.stringify({ first, result })).toBe('BAD_USER_INPUT');
    }
    tickets.listOwnedTickets.mockRejectedValueOnce(new BadRequestException('Invalid ticket cursor'));
    expect((await query('query { myTickets(after: "bad") { nextCursor } }')).errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect((await query('{ myTickets(ownerId: "other") { nextCursor } }')).errors?.[0]?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('returns nullable legacy fields without leaking a foreign ticket', async () => {
    const result = await query('query ($id: ID!) { myTicket(id: $id) { ticketId eventTitle startsAt timezone posterImageUrl qrToken unitPrice } }', { id: ticketId });
    expect(result.errors).toBeUndefined();
    expect(result.data?.myTicket).toMatchObject({ ticketId, eventTitle: null, startsAt: null, timezone: null, posterImageUrl: null, qrToken: null, unitPrice: '100000' });
    expect(tickets.getOwnedTicket).toHaveBeenCalledWith('owner-1', ticketId);

    tickets.getOwnedTicket.mockRejectedValueOnce(new NotFoundException('Ticket not found'));
    expect((await query(`{ myTicket(id: "${ticketId}") { ticketId } }`)).errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    tickets.getOwnedTicket.mockRejectedValueOnce(new ServiceUnavailableException({ code: 'TICKET_PREPARING' }));
    expect((await query(`{ myTicket(id: "${ticketId}") { ticketId } }`)).errors?.[0]?.extensions?.code).toBe('TICKET_PREPARING');
  });

  it('delegates resend and preserves cooldown, conflict, and outage error codes', async () => {
    const mutation = `mutation { resendTicketEmail(ticketId: "${ticketId}") { deliveryId status } }`;
    expect((await query(mutation)).data?.resendTicketEmail).toEqual({ deliveryId: 'delivery-1', status: 'queued' });
    expect(email.resend).toHaveBeenCalledWith('owner-1', ticketId);
    const errors = [
      [new ForbiddenException(), 'FORBIDDEN'],
      [new ConflictException(), 'CONFLICT'],
      [new ServiceUnavailableException(), 'SERVICE_UNAVAILABLE'],
    ] as const;
    for (const [error, code] of errors) {
      email.resend.mockRejectedValueOnce(error);
      expect((await query(mutation)).errors?.[0]?.extensions?.code).toBe(code);
    }
  });

  it('derives scanner identity from JWT and retains check-in result payloads', async () => {
    const input = { sessionId: 'session-1', qrToken: 'signed-token', requestId: '00000000-0000-4000-8000-000000000003' };
    const mutation = 'mutation ($input: TicketCheckInInput!) { checkInTicket(input: $input) { result ticketId } }';
    expect((await query(mutation, { input })).data?.checkInTicket).toEqual({ result: 'ACCEPTED', ticketId });
    expect(checkIn.checkInTicket).toHaveBeenCalledWith({ scannerId: 'owner-1', ...input, gateId: undefined });
    const forged = await query(mutation, { input: { ...input, scannerId: 'forged' } });
    expect(forged.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(checkIn.checkInTicket).toHaveBeenCalledTimes(1);
  });
});

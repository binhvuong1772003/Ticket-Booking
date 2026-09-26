import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver } from '@nestjs/apollo';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';
import { pruneSchema, printSchemaWithDirectives } from '@graphql-tools/utils';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { EventsResolver } from '../../event-service/src/modules/events/presentation/graphql/events.resolver';
import { EventService } from '../../event-service/src/modules/events/application/event.service';
import { EventSessionService } from '../../event-service/src/modules/events/application/event-session.service';
import { TicketTypeService } from '../../event-service/src/modules/events/application/ticket-type.service';
import { TicketTypeRepository } from '../../event-service/src/modules/events/infrastructure/ticket-type.repository';
import { EventsSessionRepository } from '../../event-service/src/modules/events/infrastructure/event-session.repository';
import { OutboxProcessor } from '../../event-service/src/modules/events/infrastructure/outbox.processor';
import { BookingResolver } from '../../booking-service/src/modules/booking/presentation/graphql/booking.resolver';
import { BookingService } from '../../booking-service/src/modules/booking/application/booking.service';
import { BookingRepository } from '../../booking-service/src/modules/booking/infrastructure/booking.repository';

// Real resolvers, JWT guards and federation transport; DB and payment are test doubles.
describe('scheduled sales through GraphQL gateway', () => {
  const apps: INestApplication[] = [];
  const secret = 'scheduled-sales-test-secret';
  const id = '000000000000000000000001';
  let gateway: INestApplication;
  let auth: ApolloServer;
  let authorization: string;
  const reserve = vi.fn();
  const createPending = vi.fn(async (data) => ({ ...data, status: 'PENDING' }));
  const createCheckout = vi.fn(() => of({ client_secret: 'test_secret' }));
  const created: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const ticketRepo = {
      createWithOutbox: vi.fn(async (data) => {
        const row = { ...data, id, salesStartAt: data.salesStartAt ?? null };
        created.push(row);
        return row;
      }),
      getTotalQuantity: vi.fn().mockResolvedValue(0),
      findByIdAndOwner: vi.fn(async () => ({
        ...created[0],
        session: {
          status: 'DRAFT',
          capacity: 100,
          event: { status: 'PUBLISHED' },
        },
      })),
      updateWithOutbox: vi.fn(async (_id, data) =>
        Object.assign(created[0], data),
      ),
    };
    const sessionRepo = {
      findByIdAndOwner: vi.fn().mockResolvedValue({
        status: 'DRAFT',
        capacity: 100,
        event: { status: 'PUBLISHED' },
      }),
    };
    const ticketService = new TicketTypeService(
      sessionRepo as unknown as EventsSessionRepository,
      ticketRepo as unknown as TicketTypeRepository,
      { wake() {} } as OutboxProcessor,
    );
    const eventModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret }),
        GraphQLModule.forRoot({
          driver: ApolloFederationDriver,
          autoSchemaFile: { federation: 2 },
          transformSchema: (schema) => {
            // Nest metadata is global in this in-process test; publish only reachable types.
            const pruned = pruneSchema(schema, {
              skipPruning: (type) =>
                type.name.startsWith('link__') ||
                type.name.startsWith('federation__'),
            });
            const sdl = printSchemaWithDirectives(pruned);
            pruned.getQueryType()!.getFields()._service.resolve = () => ({
              sdl,
            });
            return pruned;
          },
          context: ({ req }) => ({ req }),
        }),
      ],
      providers: [
        EventsResolver,
        {
          provide: EventService,
          useValue: {
            findPublished: () => [
              { id, sessions: [{ id, ticketTypes: created }] },
            ],
          },
        },
        { provide: EventSessionService, useValue: {} },
        { provide: TicketTypeService, useValue: ticketService },
      ],
    }).compile();
    const events = eventModule.createNestApplication({ logger: false });
    apps.push(events);
    events.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await events.listen(0, '127.0.0.1');

    const bookingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret }),
        GraphQLModule.forRoot({
          driver: ApolloFederationDriver,
          autoSchemaFile: { federation: 2 },
          transformSchema: (schema) => {
            // Nest metadata is global in this in-process test; publish only reachable types.
            const pruned = pruneSchema(schema, {
              skipPruning: (type) =>
                type.name.startsWith('link__') ||
                type.name.startsWith('federation__'),
            });
            const sdl = printSchemaWithDirectives(pruned);
            pruned.getQueryType()!.getFields()._service.resolve = () => ({
              sdl,
            });
            return pruned;
          },
          context: ({ req }) => ({ req }),
        }),
      ],
      providers: [
        BookingResolver,
        BookingService,
        { provide: BookingRepository, useValue: { createPending } },
        {
          provide: 'INVENTORY_GRPC',
          useValue: { getService: () => ({ reserve }) },
        },
        {
          provide: 'PAYMENT_GRPC',
          useValue: { getService: () => ({ createCheckout }) },
        },
      ],
    }).compile();
    const bookings = bookingModule.createNestApplication({ logger: false });
    apps.push(bookings);
    await bookings.listen(0, '127.0.0.1');
    authorization =
      'Bearer ' +
      new JwtService({ secret }).sign({ sub: 'test-user', role: 'ORGANIZER' });

    auth = new ApolloServer({
      schema: buildSubgraphSchema({
        typeDefs: parse('type Query { health: String! }'),
        resolvers: { Query: { health: () => 'ok' } },
      }),
    });
    const { url } = await startStandaloneServer(auth, {
      listen: { port: 0, host: '127.0.0.1' },
    });
    vi.stubEnv('AUTH_SERVICE_URL', url);
    vi.stubEnv('EVENT_SERVICE_URL', (await events.getUrl()) + '/graphql');
    vi.stubEnv('BOOKING_SERVICE_URL', (await bookings.getUrl()) + '/graphql');
    vi.stubEnv('OBSERVE_APP_KEY', '');
    vi.stubEnv('OBSERVE_APP_SECRET', '');
    const { AppModule } = await import('../src/app.module');
    const gatewayModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    gateway = gatewayModule.createNestApplication({ logger: false });
    apps.push(gateway);
    await gateway.init();
  }, 20000);

  afterAll(async () => {
    for (const app of apps.reverse()) await app.close();
    await auth?.stop();
    vi.unstubAllEnvs();
  });

  it('creates, queries, updates and clears the UTC opening time', async () => {
    const result = await request(gateway.getHttpServer())
      .post('/graphql')
      .set('authorization', authorization)
      .send({
        query:
          'mutation($input: CreateTicketTypeInput!) { createTicketType(input: $input) { id salesStartAt } }',
        variables: {
          input: {
            sessionId: id,
            name: 'VIP',
            code: 'VIP',
            price: 100,
            quantity: 10,
            salesStartAt: '2026-10-01T07:00:00+07:00',
          },
        },
      });
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.createTicketType.salesStartAt).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    const queried = await request(gateway.getHttpServer())
      .post('/graphql')
      .send({
        query: '{ events { sessions { ticketTypes { salesStartAt } } } }',
      });
    expect(queried.body.errors).toBeUndefined();
    expect(
      queried.body.data.events[0].sessions[0].ticketTypes[0].salesStartAt,
    ).toBe('2026-10-01T00:00:00.000Z');
    const update = await request(gateway.getHttpServer())
      .post('/graphql')
      .set('authorization', authorization)
      .send({
        query:
          'mutation { updateTicketType(input: { id: "' +
          id +
          '", salesStartAt: "2027-01-01T00:00:00Z" }) { id salesStartAt } }',
      });
    expect(update.body.errors).toBeUndefined();
    expect(update.body.data.updateTicketType.salesStartAt).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    const reset = await request(gateway.getHttpServer())
      .post('/graphql')
      .set('authorization', authorization)
      .send({
        query:
          'mutation($input: UpdateTicketTypeInput!) { updateTicketType(input: $input) { salesStartAt } }',
        variables: { input: { id, salesStartAt: null } },
      });
    expect(reset.body.errors).toBeUndefined();
    expect(reset.body.data.updateTicketType.salesStartAt).toBeNull();
  });

  it.each(['2026-10-01T07:00:00', '2026-10-01', '2026-02-30T07:00:00Z'])(
    'rejects ambiguous or invalid opening time %s',
    async (salesStartAt) => {
      const count = created.length;
      const result = await request(gateway.getHttpServer())
        .post('/graphql')
        .set('authorization', authorization)
        .send({
          query:
            'mutation($input: CreateTicketTypeInput!) { createTicketType(input: $input) { id } }',
          variables: {
            input: {
              sessionId: id,
              name: 'VIP',
              code: 'VIP',
              price: 100,
              quantity: 1,
              salesStartAt,
            },
          },
        });
      expect(result.body.errors).toBeDefined();
      expect(created).toHaveLength(count);
    },
  );

  it.each(['2026-10-01T07:00:00', '2026-02-30T07:00:00Z'])(
    'rejects invalid schedule update %s',
    async (salesStartAt) => {
      const before = created[0].salesStartAt;
      const result = await request(gateway.getHttpServer())
        .post('/graphql')
        .set('authorization', authorization)
        .send({
          query:
            'mutation($input: UpdateTicketTypeInput!) { updateTicketType(input: $input) { id } }',
          variables: { input: { id, salesStartAt } },
        });
      expect(result.body.errors).toBeDefined();
      expect(created[0].salesStartAt).toEqual(before);
    },
  );

  it('forwards not-started errors without creating a booking or checkout', async () => {
    reserve.mockReturnValue(
      throwError(() =>
        Object.assign(new Error('not started'), {
          code: 9,
          details: 'Ticket sales have not started',
        }),
      ),
    );
    const result = await request(gateway.getHttpServer())
      .post('/graphql')
      .set('authorization', authorization)
      .send({
        query:
          'mutation($input: CreateBookingInput!) { createBooking(input: $input) { id status } }',
        variables: {
          input: { eventId: id, sessionId: id, ticketTypeId: id, quantity: 1 },
        },
      });
    expect(result.body.errors[0].extensions.code).toBe(
      'TICKET_SALES_NOT_STARTED',
    );
    expect(createPending).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('creates a pending booking when inventory allows the reservation', async () => {
    reserve.mockReturnValue(
      of({
        success: true,
        reservation_id: 'hold1',
        ticket_type_name: 'VIP',
        ticket_type_code: 'VIP',
        unit_price: 100,
        currency: 'USD',
      }),
    );
    const result = await request(gateway.getHttpServer())
      .post('/graphql')
      .set('authorization', authorization)
      .send({
        query:
          'mutation($input: CreateBookingInput!) { createBooking(input: $input) { status checkoutClientSecret } }',
        variables: {
          input: { eventId: id, sessionId: id, ticketTypeId: id, quantity: 1 },
        },
      });
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.createBooking).toEqual({
      status: 'PENDING',
      checkoutClientSecret: 'test_secret',
    });
  });
});

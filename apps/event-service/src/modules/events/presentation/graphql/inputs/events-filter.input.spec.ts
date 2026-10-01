import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import { ApolloFederationDriver } from '@nestjs/apollo';
import type { GraphQLInputObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { EventsFilterInput } from './events-filter.input';
import { EventsResolver } from '../events.resolver';
import { LocationResolver } from '../location.resolver';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const metadata = { type: 'body' as const, metatype: EventsFilterInput };

describe('EventsFilterInput validation', () => {
  it('accepts filters after GraphQL has parsed date scalars', async () => {
    const filter = {
      q: 'music',
      city: 'Hanoi',
      startsAtFrom: new Date('2026-09-01T00:00:00+07:00'),
      startsAtTo: new Date('2026-09-30T23:59:59.999+07:00'),
      upcomingOnly: true,
      countryCode: 'VN',
      placeId: 'VN-HOCHIMINH',
    };
    await expect(pipe.transform(filter, metadata)).resolves.toMatchObject(filter);
    await expect(pipe.transform({}, metadata)).resolves.toMatchObject({ upcomingOnly: false });
  });

  it('accepts explicit null for optional location fields', async () => {
    await expect(
      pipe.transform({ countryCode: null, placeId: null }, metadata),
    ).resolves.toMatchObject({ countryCode: null, placeId: null });
  });

  it('rejects invalid field types and unknown fields', async () => {
    for (const filter of [
      { q: 123 },
      { city: [] },
      { countryCode: 'USA' },
      { placeId: 123 },
      { startsAtFrom: new Date('invalid') },
      { startsAtTo: 'invalid' },
      { upcomingOnly: 'true' },
      { unknown: true },
    ]) {
      await expect(pipe.transform(filter, metadata)).rejects.toMatchObject({ status: 400 });
    }
  });
});

it('builds the compiled GraphQL schema with nullable location filters', async () => {
  class SchemaModule {}
  Module({
    imports: [
      GraphQLModule.forRoot({
        driver: ApolloFederationDriver,
        autoSchemaFile: { federation: 2 },
      }),
    ],
    providers: [EventsResolver, LocationResolver].map((resolver) => ({
      provide: resolver,
      useValue: Object.create(resolver.prototype),
    })),
  })(SchemaModule);

  const app = await NestFactory.createApplicationContext(SchemaModule, {
    logger: false,
  });
  try {
    await app.init();
    const schema = app.get(GraphQLSchemaHost, { strict: false }).schema;
    const eventsFilter = schema.getType('EventsFilterInput') as GraphQLInputObjectType;
    const sessionsFilter = schema.getType('EventSessionsFilterInput') as GraphQLInputObjectType;
    expect(String(eventsFilter.getFields().countryCode.type)).toBe('String');
    expect(String(sessionsFilter.getFields().countryCode.type)).toBe('String');
  } finally {
    await app.close();
  }
});

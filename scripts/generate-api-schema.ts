import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { parse, printSchema } from 'graphql';
import { composeServices } from '@apollo/composition';
import { Supergraph } from '@apollo/federation-internals';

import { AuthResolver } from '../apps/auth-service/src/modules/auth/presentation/graphql/auth.resolver.js';
import { EventsResolver } from '../apps/event-service/src/modules/events/presentation/graphql/events.resolver';
import { BookingResolver } from '../apps/booking-service/src/modules/booking/presentation/graphql/booking.resolver';

const OUT_DIR = join(__dirname, '..', 'docs', 'api');

// ponytail: resolver instances are faked via Object.create so DI never
// instantiates services (Prisma, Kafka, JWT...). getAllCtors() only needs
// instance.constructor to point at the resolver class.
const stub = (cls: new () => object) => ({
  provide: cls,
  useValue: Object.create(cls.prototype),
});

async function buildSubgraphSdl(resolvers: (new () => object)[]) {
  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloFederationDriverConfig>({
        driver: ApolloFederationDriver,
        autoSchemaFile: { federation: 2 },
      }),
    ],
    providers: resolvers.map(stub),
  })
  class SchemaModule {}

  const app = await NestFactory.createApplicationContext(SchemaModule, {
    logger: false,
  });
  await app.init();
  const { schema } = app.get(GraphQLSchemaHost, { strict: false });
  await app.close();
  return printSchemaWithDirectives(schema);
}

const subgraphs = [
  { name: 'auth', resolvers: [AuthResolver] },
  { name: 'events', resolvers: [EventsResolver] },
  { name: 'booking', resolvers: [BookingResolver] },
];

async function main() {
  const sdls = await Promise.all(
    subgraphs.map(async ({ name, resolvers }) => ({
      name,
      typeDefs: parse(await buildSubgraphSdl(resolvers)),
    })),
  );

  const result = composeServices(sdls);
  if (!result.supergraphSdl || result.errors?.length) {
    throw new Error(
      `Composition failed:\n${(result.errors ?? []).map((e) => e.message).join('\n')}`,
    );
  }

  const apiSchema = Supergraph.build(result.supergraphSdl)
    .apiSchema()
    .toGraphQLJSSchema();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'schema.graphql'), printSchema(apiSchema));
  console.log(`Wrote ${join(OUT_DIR, 'schema.graphql')}`);
}

void main();

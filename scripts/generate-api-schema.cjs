// Generates docs/api/schema.graphql = the composed public API schema.
// Runs against dist/apps/* compiled output, so run `bun run build` first
// when resolvers changed.
//
// Each subgraph is built in its own process (SUBGRAPH=name env) because
// @nestjs/graphql decorator metadata lives in global storage and types
// would leak between schemas built in one process.
require('reflect-metadata');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { GraphQLModule, GraphQLSchemaHost } = require('@nestjs/graphql');
const { ApolloFederationDriver } = require('@nestjs/apollo');
const { printSchemaWithDirectives } = require('@graphql-tools/utils');
const { parse, printSchema } = require('graphql');
const { composeServices } = require('@apollo/composition');
const { Supergraph } = require('@apollo/federation-internals');

const OUT_DIR = join(__dirname, '..', 'docs', 'api');
const TMP_DIR = join(__dirname, '..', 'node_modules', '.cache', 'subgraphs');

const subgraphs = {
  auth: require.resolve('../dist/apps/auth-service/modules/auth/presentation/graphql/auth.resolver'),
  events:
    require.resolve('../dist/apps/event-service/modules/events/presentation/graphql/events.resolver'),
  booking:
    require.resolve('../dist/apps/booking-service/modules/booking/presentation/graphql/booking.resolver'),
};

// ponytail: resolver instances are faked via Object.create so DI never
// instantiates services (Prisma, Kafka, JWT...). getAllCtors() only needs
// instance.constructor to point at the resolver class.
async function buildSubgraphSdl(name) {
  const resolverModule = require(subgraphs[name]);
  const resolvers = Object.values(resolverModule).filter(
    (v) => typeof v === 'function',
  );

  class SchemaModule {}
  Module({
    imports: [
      GraphQLModule.forRoot({
        driver: ApolloFederationDriver,
        autoSchemaFile: { federation: 2 },
      }),
    ],
    providers: resolvers.map((cls) => ({
      provide: cls,
      useValue: Object.create(cls.prototype),
    })),
  })(SchemaModule);

  const app = await NestFactory.createApplicationContext(SchemaModule, {
    logger: false,
  });
  await app.init();
  const { schema } = app.get(GraphQLSchemaHost, { strict: false });
  await app.close();
  return printSchemaWithDirectives(schema);
}

async function main() {
  const worker = process.env.SUBGRAPH;
  if (worker) {
    writeFileSync(
      join(TMP_DIR, `${worker}.graphql`),
      await buildSubgraphSdl(worker),
    );
    return;
  }

  mkdirSync(TMP_DIR, { recursive: true });
  const names = Object.keys(subgraphs);
  for (const name of names) {
    execFileSync(process.execPath, [__filename], {
      env: { ...process.env, SUBGRAPH: name },
      stdio: 'inherit',
    });
  }

  const result = composeServices(
    names.map((name) => ({
      name,
      typeDefs: parse(readFileSync(join(TMP_DIR, `${name}.graphql`), 'utf8')),
    })),
  );
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

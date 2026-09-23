import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { connect } from 'node:net';
import { AppModule, ObserveInstrument, observeEnabled } from './app.module.js';
import { jwtMiddleware } from './common/auth/jwt.middleware.js';

const logger = new Logger('GatewayBootstrap');

const SUBGRAPH_WAIT_TIMEOUT_MS = 120_000;
const SUBGRAPH_WAIT_INTERVAL_MS = 2_000;

function canConnect(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// Subgraphs bind sau khi microservice deps (Kafka) sẵn sàng —
// đợi port mở trước khi introspect, tránh crash khi boot song song
async function waitForSubgraphs(urls: string[]) {
  const targets = urls.map((url) => {
    const { hostname, port } = new URL(url);
    return { host: hostname, port: Number(port) || 80 };
  });
  const deadline = Date.now() + SUBGRAPH_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const pending: string[] = [];
    for (const target of targets) {
      if (!(await canConnect(target.host, target.port))) {
        pending.push(`${target.host}:${target.port}`);
      }
    }
    if (pending.length === 0) {
      return;
    }
    logger.log(`Waiting for subgraphs: ${pending.join(', ')}`);
    await new Promise((resolve) =>
      setTimeout(resolve, SUBGRAPH_WAIT_INTERVAL_MS),
    );
  }
  logger.warn('Timed out waiting for subgraphs, starting anyway');
}

async function bootstrap() {
  const subgraphUrls = [
    process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001/graphql',
    process.env.EVENT_SERVICE_URL ?? 'http://localhost:4003/graphql',
    process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql',
  ];
  await waitForSubgraphs(subgraphUrls);
  await startApp();
}

async function startApp() {
  const app = await NestFactory.create(
    AppModule,
    observeEnabled ? { instrument: ObserveInstrument } : undefined,
  );
  const port = Number(process.env.PORT ?? 3000);
  const frontendOrigin = process.env.FRONTEND_ORIGIN;

  if (frontendOrigin) {
    app.enableCors({
      origin: frontendOrigin,
      credentials: true,
    });
  }
  app.use('/graphql', jwtMiddleware);
  app.use('/uploads', jwtMiddleware);
  const server = await app.listen(port);
  /* Default 5s keep-alive drops idle sockets too fast for Docker Desktop's
     ~200ms connect on Windows — every pause costs a new handshake through
     docker-proxy. 60s keeps dev connections warm between interactions. */
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;
  logger.log(`Gateway listening on http://localhost:${port}/graphql`);
  if (!observeEnabled) {
    logger.log(
      'Nest Observe disabled. Set OBSERVE_APP_KEY and OBSERVE_APP_SECRET to enable it.',
    );
  }
}
void bootstrap();

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument, observeEnabled } from './app.module.js';
import { jwtMiddleware } from './common/auth/jwt.middleware.js';

const logger = new Logger('GatewayBootstrap');

async function bootstrap() {
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
  await app.listen(port);
  logger.log(`Gateway listening on http://localhost:${port}/graphql`);
  if (!observeEnabled) {
    logger.log(
      'Nest Observe disabled. Set OBSERVE_APP_KEY and OBSERVE_APP_SECRET to enable it.',
    );
  }
}
void bootstrap();

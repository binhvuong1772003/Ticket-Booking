import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const logger = new Logger('AuthBootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.AUTH_PORT ?? 4001);

  await app.listen(port);
  logger.log(`Auth service listening on http://localhost:${port}/graphql`);
}

void bootstrap();

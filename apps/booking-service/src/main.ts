import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const logger = new Logger('BookingBootstrap');

async function bootstrap() {
  const port = Number(process.env.BOOKING_PORT ?? 4002);
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Booking service listening on http://localhost:${port}/graphql`);
}

void bootstrap();

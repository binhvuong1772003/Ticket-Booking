import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

const logger = new Logger('BookingBootstrap');

async function bootstrap() {
  const port = Number(process.env.BOOKING_PORT ?? 3001);
  const host = process.env.BOOKING_HOST ?? '127.0.0.1';
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.TCP,
      options: { host, port },
    },
  );
  app.enableShutdownHooks();

  await app.listen();
  logger.log(`Booking service listening on tcp://${host}:${port}`);
}

void bootstrap();

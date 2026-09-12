import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.TCP,
      options: {
        host: process.env.BOOKING_HOST ?? '127.0.0.1',
        port: Number(process.env.BOOKING_PORT ?? 3001),
      },
    },
  );
  app.enableShutdownHooks();
  await app.listen();
}

await bootstrap();

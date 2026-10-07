import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'notification-service',
        brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
      },
      consumer: { groupId: 'notification-service' },
    },
  });
  await app.startAllMicroservices();
  await app.listen(Number(process.env.NOTIFICATION_PORT ?? 4004), '0.0.0.0');
}
bootstrap();

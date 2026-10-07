import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'ticket',
      protoPath: join(process.cwd(), 'libs/contracts/proto/ticket.proto'),
      url: process.env.TICKET_GRPC_URL || '0.0.0.0:50053',
      // proto-loader mặc định camelCase hoá field name — giữ snake_case
      // để khớp handler code
      loader: { keepCase: true },
    },
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'ticket-service',
        brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
      },
      consumer: {
        groupId: 'ticket-service',
      },
      subscribe: {
        fromBeginning: true,
      },
    },
  });
  await app.startAllMicroservices();
  await app.listen(process.env.TICKET_HTTP_PORT ?? 4005);
}

void bootstrap();

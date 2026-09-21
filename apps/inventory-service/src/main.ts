import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'inventory',
      protoPath: join(process.cwd(), 'libs/contracts/proto/inventory.proto'),
      url: '0.0.0.0:50051',
      // proto-loader mặc định camelCase hoá field name — giữ snake_case
      // để khớp handler code
      loader: { keepCase: true },
    },
  });
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'inventory-service',
        brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
      },
      consumer: {
        groupId: 'inventory-service',
      },
      subscribe: {
        fromBeginning: true,
      },
    },
  });
  await app.startAllMicroservices();
}

bootstrap();

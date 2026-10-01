import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { BookingService } from './application/booking.service.js';
import { BookingResolver } from './presentation/graphql/booking.resolver';
import { BookingController } from './presentation/messaging/booking.controller';
import { BookingRepository } from './infrastructure/booking.repository';
import { BookingSweeper } from './infrastructure/booking.sweeper';
import { OutboxProcessor } from './infrastructure/outbox.processor';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { BookingInternalServiceTokenGuard } from '../../common/auth/booking-internal-service-token.guard';

@Module({
  imports: [
    PrismaModule,
    ClientsModule.register([
      {
        name: 'INVENTORY_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'inventory',
          protoPath: join(
            process.cwd(),
            'libs/contracts/proto/inventory.proto',
          ),
          url: process.env.INVENTORY_GRPC_URL ?? 'localhost:50051',
          loader: { keepCase: true },
        },
      },
      {
        name: 'PAYMENT_GRPC',
        transport: Transport.GRPC,
        options: {
          package: 'payment',
          protoPath: join(process.cwd(), 'libs/contracts/proto/payment.proto'),
          url: process.env.PAYMENT_GRPC_URL ?? 'localhost:50052',
          loader: { keepCase: true },
        },
      },
      {
        name: 'BOOKING_KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'booking-service',
            brokers: [process.env.KAFKA_BROKERS ?? 'localhost:9092'],
          },
          consumer: {
            groupId: 'booking-service-producer',
          },
        },
      },
    ]),
  ],
  controllers: [BookingController],
  providers: [
    BookingResolver,
    BookingService,
    BookingRepository,
    BookingSweeper,
    OutboxProcessor,
    JwtAuthGuard,
    BookingInternalServiceTokenGuard,
  ],
})
export class BookingModule {}

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { BookingService } from './application/booking.service.js';
import { BookingResolver } from './presentation/graphql/booking.resolver';
import { BookingRepository } from './infrastructure/booking.repository';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';

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
        },
      },
    ]),
  ],
  providers: [BookingResolver, BookingService, BookingRepository, JwtAuthGuard],
})
export class BookingModule {}

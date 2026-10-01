import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/auth/optional-jwt-auth.guard';
import { OrganizerGuard } from '../../common/auth/organizer.guard';
import { EventsResolver } from './presentation/graphql/events.resolver';
import { EventService } from './application/event.service';
import { EventSessionService } from './application/event-session.service';
import { TicketTypeService } from './application/ticket-type.service';
import { EventsRepository } from './infrastructure/events.repository';
import { EventsSessionRepository } from './infrastructure/event-session.repository';
import { TicketTypeRepository } from './infrastructure/ticket-type.repository';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OutboxProcessor } from './infrastructure/outbox.processor';
import { InternalServiceTokenGuard } from '../../common/auth/internal-service-token.guard';
import { AdminGuard } from '../../common/auth/admin.guard';
import { CategoryService } from './application/category.service';
import { CategoryRepository } from './infrastructure/category.repository';
import { CategoriesResolver } from './presentation/graphql/categories.resolver';
import { PublicCategoriesResolver } from './presentation/graphql/public-categories.resolver';
import { TrendingService } from './application/trending.service';
import { BookingTrendingClient } from './infrastructure/booking-trending.client';
import { InventoryAvailabilityClient } from './infrastructure/inventory-availability.client';
import { TicketTypeAvailabilityResolver } from './presentation/graphql/ticket-type-availability.resolver';
import { EventAvailabilityResolver } from './presentation/graphql/event-availability.resolver';
import { LocationResolver } from './presentation/graphql/location.resolver';

@Module({
  imports: [
    PrismaModule,
    ClientsModule.register([
      {
        name: 'EVENT_KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'event-service',
            brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'],
          },
          consumer: {
            groupId: 'event-service-producer',
          },
        },
      },
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
    ]),
  ],
  providers: [
    EventsResolver,
    TicketTypeAvailabilityResolver,
    EventAvailabilityResolver,
    LocationResolver,
    CategoriesResolver,
    PublicCategoriesResolver,
    EventService,
    CategoryService,
    EventSessionService,
    TicketTypeService,
    EventsRepository,
    CategoryRepository,
    EventsSessionRepository,
    TicketTypeRepository,
    JwtAuthGuard,
    AdminGuard,
    OptionalJwtAuthGuard,
    OrganizerGuard,
    InternalServiceTokenGuard,
    OutboxProcessor,
    TrendingService,
    BookingTrendingClient,
    InventoryAvailabilityClient,
  ],
  exports: [EventService, EventSessionService, TicketTypeService],
})
export class EventsModule {}

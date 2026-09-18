import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
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
    ]),
  ],
  providers: [
    EventsResolver,
    EventService,
    EventSessionService,
    TicketTypeService,
    EventsRepository,
    EventsSessionRepository,
    TicketTypeRepository,
    JwtAuthGuard,
    OrganizerGuard,
    OutboxProcessor,
  ],
  exports: [EventService, EventSessionService, TicketTypeService],
})
export class EventsModule {}

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { TicketService } from './application/ticket.service';
import { TicketCredentialService } from './application/credential.service';
import { TicketRepository } from './infrastructure/ticket.repository';
import { OutboxProcessor } from './infrastructure/outbox.processor';
import { TicketConsumer } from './presentation/messaging/ticket.consumer';
import { EventSnapshotClient } from './infrastructure/event-snapshot.client';
import { BookingSnapshotClient } from './infrastructure/booking-snapshot.client';
import { TicketGrpcController } from './presentation/grpc/ticket.controller';
import { TicketQueryService } from './application/ticket-query.service';
import { TicketRendererService } from './application/ticket-renderer.service';
import { TicketCheckInService } from './application/ticket-checkin.service';
import { TicketResolver } from './presentation/graphql/ticket.resolver';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TicketEmailClient } from './infrastructure/ticket-email.client';

@Module({
  imports: [
    PrismaModule,
    ClientsModule.register([
      {
        name: 'TICKET_KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'ticket-service',
            brokers: [process.env.KAFKA_BROKERS ?? 'localhost:9092'],
          },
          consumer: {
            groupId: 'ticket-service-producer',
          },
        },
      },
    ]),
  ],
  controllers: [TicketConsumer, TicketGrpcController],
  providers: [
    TicketService,
    TicketCredentialService,
    TicketRepository,
    TicketQueryService,
    TicketRendererService,
    TicketCheckInService,
    OutboxProcessor,
    EventSnapshotClient,
    BookingSnapshotClient,
    TicketResolver,
    JwtAuthGuard,
    TicketEmailClient,
  ],
})
export class TicketServiceModule {}

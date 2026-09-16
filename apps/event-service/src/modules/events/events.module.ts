import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { EventsResolver } from './presentation/graphql/events.resolver';
import { EventsService } from './application/events.service';
import { EventsRepository } from './infrastructure/events.repository';
import { EventsSessionRepository } from './infrastructure/event-session.repository';

@Module({
  imports: [PrismaModule],
  providers: [
    EventsResolver,
    EventsService,
    EventsRepository,
    EventsSessionRepository,
    JwtAuthGuard,
  ],
  exports: [EventsService],
})
export class EventsModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'node:path';
import { UserRegisteredConsumer } from './presentation/messaging/user-registered.consumer.js';
import { PaymentRefundedConsumer } from './presentation/messaging/payment-refunded.consumer.js';
import { TicketIssuedConsumer } from './presentation/messaging/ticket-issued.consumer.js';
import { UserRegisteredEmailHandler } from './application/handlers/user-registered.handler.js';
import { PaymentRefundedEmailHandler } from './application/handlers/payment-refunded.handler.js';
import { TicketIssuedEmailHandler } from './application/handlers/ticket-issued.handler.js';
import { EmailTemplate } from './infrastructure/email/email.template.js';
import { SmtpProvider } from './infrastructure/email/email.provider.js';
import { EmailProcessor } from './infrastructure/email/email.processor.js';
import { AuthClient } from './infrastructure/auth/auth.client.js';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module.js';
import { EmailDeliveryRepository } from './infrastructure/email/email-delivery.repository.js';
import { TicketClient } from './infrastructure/tickets/ticket.client.js';
import { TicketResendController } from './presentation/http/ticket-resend.controller.js';
import { BookingRecipientClient } from './infrastructure/booking/booking-recipient.client.js';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: 'email' }),
    ClientsModule.register([{
      name: 'TICKET_GRPC',
      transport: Transport.GRPC,
      options: {
        package: 'ticket',
        protoPath: join(process.cwd(), 'libs/contracts/proto/ticket.proto'),
        url: process.env.TICKET_GRPC_URL ?? 'localhost:50053',
        loader: { keepCase: true },
      },
    }]),
  ],
  controllers: [
    UserRegisteredConsumer,
    PaymentRefundedConsumer,
    TicketIssuedConsumer,
    TicketResendController,
  ],
  providers: [
    UserRegisteredEmailHandler,
    PaymentRefundedEmailHandler,
    TicketIssuedEmailHandler,
    EmailTemplate,
    SmtpProvider,
    EmailProcessor,
    AuthClient,
    BookingRecipientClient,
    TicketClient,
    EmailDeliveryRepository,
  ],
})
export class NotificationsModule {}

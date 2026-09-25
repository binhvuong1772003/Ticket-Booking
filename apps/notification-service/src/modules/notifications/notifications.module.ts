import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UserRegisteredConsumer } from './presentation/messaging/user-registered.consumer.js';
import { PaymentRefundedConsumer } from './presentation/messaging/payment-refunded.consumer.js';
import { UserRegisteredEmailHandler } from './application/handlers/user-registered.handler.js';
import { PaymentRefundedEmailHandler } from './application/handlers/payment-refunded.handler.js';
import { EmailTemplate } from './infrastructure/email/email.template.js';
import { SmtpProvider } from './infrastructure/email/email.provider.js';
import { EmailProcessor } from './infrastructure/email/email.processor.js';
import { AuthClient } from './infrastructure/auth/auth.client.js';

@Module({
  imports: [BullModule.registerQueue({ name: 'email' })],
  controllers: [UserRegisteredConsumer, PaymentRefundedConsumer],
  providers: [
    UserRegisteredEmailHandler,
    PaymentRefundedEmailHandler,
    EmailTemplate,
    SmtpProvider,
    EmailProcessor,
    AuthClient,
  ],
})
export class NotificationsModule {}

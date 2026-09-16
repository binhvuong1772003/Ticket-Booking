import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UserRegisteredConsumer } from './presentation/messaging/user-registered.consumer.js';
import { UserRegisteredEmailHandler } from './application/handlers/user-registered.handler.js';
import { EmailTemplate } from './infrastructure/email/email.template.js';
import { SmtpProvider } from './infrastructure/email/email.provider.js';
import { EmailProcessor } from './infrastructure/email/email.processor.js';

@Module({
  imports: [BullModule.registerQueue({ name: 'email' })],
  controllers: [UserRegisteredConsumer],
  providers: [
    UserRegisteredEmailHandler,
    EmailTemplate,
    SmtpProvider,
    EmailProcessor,
  ],
})
export class NotificationsModule {}

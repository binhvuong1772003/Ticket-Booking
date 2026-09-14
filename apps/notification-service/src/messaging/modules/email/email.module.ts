import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UserRegisteredConsumer } from '../../kafka/consumers/user-registered.consumer.js';
import { UserRegisteredEmailHandler } from './application/handlers/user-registered.handler.js';
import { EmailTemplate } from './infrastructure/email.template.js';
import { SmtpProvider } from './infrastructure/email.provider.js';
import { EmailProcessor } from './infrastructure/email.processor.js';

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
export class EmailModule {}

import { Module } from '@nestjs/common';
import { UserRegisteredConsumer } from '../../kafka/consumers/user-registered.consumer.js';
import { UserRegisteredEmailHandler } from './application/handlers/user-registered.handler.js';
import { EmailTemplate } from './infrastructure/email.template.js';
import { SmtpProvider } from './infrastructure/email.provider.js';

@Module({
  controllers: [UserRegisteredConsumer],
  providers: [UserRegisteredEmailHandler, EmailTemplate, SmtpProvider],
})
export class EmailModule {}

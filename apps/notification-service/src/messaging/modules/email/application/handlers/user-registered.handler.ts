import { Injectable, Logger } from '@nestjs/common';
import type { UserRegisteredEvent } from '../../../../../../../../libs/contracts/src/events/auth/user-registered.event';
import { SmtpProvider } from '../../infrastructure/email.provider.js';
import { EmailTemplate } from '../../infrastructure/email.template.js';

@Injectable()
export class UserRegisteredEmailHandler {
  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly emailTemplate: EmailTemplate,
  ) {}
  private readonly logger = new Logger(UserRegisteredEmailHandler.name);

  async handleUserRegistered(event: UserRegisteredEvent) {
    const html = this.emailTemplate.welcome(event.payload.email);
    await this.smtpProvider.sendEmail(
      event.payload.email,
      'Welcome to our platform',
      html,
    );
    this.logger.log(
      `Received user registered event for ${event.payload.email}`,
    );

    this.logger.debug(JSON.stringify(event));

    return { received: true };
  }
}

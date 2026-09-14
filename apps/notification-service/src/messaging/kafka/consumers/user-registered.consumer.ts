import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { UserRegisteredEvent } from '../../../../../../libs/contracts/src/events/auth/user-registered.event';
import { UserRegisteredEmailHandler } from '../../modules/email/application/handlers/user-registered.handler.js';

@Controller()
export class UserRegisteredConsumer {
  constructor(
    private readonly userRegisteredEmailHandler: UserRegisteredEmailHandler,
  ) {}

  @EventPattern('auth.user.registered')
  handleUserRegistered(@Payload() event: UserRegisteredEvent) {
    return this.userRegisteredEmailHandler.handleUserRegistered(event);
  }
}

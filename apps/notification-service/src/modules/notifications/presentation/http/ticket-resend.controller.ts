import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { TicketIssuedEmailHandler } from '../../application/handlers/ticket-issued.handler';

@Controller('internal/tickets')
export class TicketResendController {
  constructor(private readonly deliveries: TicketIssuedEmailHandler) {}

  @Post(':ticketId/resend')
  @HttpCode(202)
  async resend(
    @Param('ticketId') ticketId: string,
    @Headers('x-notification-service-token') token: string | undefined,
    @Body() body: { ownerId?: string },
  ) {
    const expected = process.env.NOTIFICATION_INTERNAL_SERVICE_TOKEN;
    if (
      !expected || !token ||
      Buffer.byteLength(expected) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ) throw new UnauthorizedException('Invalid internal service token');
    if (!body.ownerId) throw new ForbiddenException('Authenticated owner is required');
    return this.deliveries.queueTicketResend(body.ownerId, ticketId);
  }
}

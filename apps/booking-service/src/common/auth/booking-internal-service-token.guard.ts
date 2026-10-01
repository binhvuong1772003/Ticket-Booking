import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class BookingInternalServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const received = GqlExecutionContext.create(context)
      .getContext<{ req: { headers: Record<string, string | undefined> } }>()
      .req.headers['x-booking-service-token'];
    const expected = process.env.BOOKING_INTERNAL_SERVICE_TOKEN;
    if (!received || !expected) throw new UnauthorizedException('Internal service authentication required');
    const supplied = Buffer.from(received);
    const configured = Buffer.from(expected);
    if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) {
      throw new UnauthorizedException('Internal service authentication required');
    }
    return true;
  }
}

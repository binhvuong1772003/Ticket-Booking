import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { timingSafeEqual } from 'node:crypto';

export function hasValidInternalToken(
  received: string | undefined,
  expected: string | undefined,
) {
  if (!received || !expected) {
    return false;
  }
  const supplied = Buffer.from(received);
  const configured = Buffer.from(expected);
  return (
    supplied.length === configured.length &&
    timingSafeEqual(supplied, configured)
  );
}

@Injectable()
export class InternalServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = GqlExecutionContext.create(context)
      .getContext<{ req: { headers: Record<string, string | undefined> } }>()
      .req;
    if (
      !hasValidInternalToken(
        request.headers['x-event-service-token'],
        process.env.EVENT_INTERNAL_SERVICE_TOKEN,
      )
    ) {
      throw new UnauthorizedException('Internal service authentication required');
    }
    return true;
  }
}

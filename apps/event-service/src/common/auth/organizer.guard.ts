import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

type OrganizerRequest = {
  user?: {
    role?: string;
  };
};

@Injectable()
export class OrganizerGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = GqlExecutionContext.create(context)
      .getContext<{ req: OrganizerRequest }>()
      .req;

    if (request.user?.role !== 'ORGANIZER') {
      throw new ForbiddenException('Organizer role is required');
    }

    return true;
  }
}

import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

@Injectable()
export class AdminGuard extends JwtAuthGuard {
  constructor(jwtService: JwtService) {
    super(jwtService);
  }

  override canActivate(context: ExecutionContext) {
    super.canActivate(context);
    const request = GqlExecutionContext.create(context).getContext<{
      req: { user?: { role?: string } };
    }>().req;

    if (request.user?.role !== 'ADMIN') {
      throw new ForbiddenException('Admin role is required');
    }
    return true;
  }
}

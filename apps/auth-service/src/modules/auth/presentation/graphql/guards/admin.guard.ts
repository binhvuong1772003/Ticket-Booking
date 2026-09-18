import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';

type AdminJwtPayload = {
  sub: string;
  role: string;
};

type AdminRequest = {
  headers: {
    authorization?: string;
  };
  user?: AdminJwtPayload;
};

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext) {
    const request = GqlExecutionContext.create(context).getContext<{
      req: AdminRequest;
    }>().req;

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    try {
      const payload = this.jwtService.verify<AdminJwtPayload>(token);
      request.user = payload;

      if (payload.role !== 'ADMIN') {
        throw new ForbiddenException('Admin role is required');
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

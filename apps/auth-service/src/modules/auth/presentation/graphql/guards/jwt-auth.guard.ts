import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';

export type AuthUser = {
  sub: string;
  email: string;
  role: string;
};

export type AuthRequest = {
  headers: {
    authorization?: string;
  };
  user?: AuthUser;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext) {
    const request = GqlExecutionContext.create(context).getContext<{
      req: AuthRequest;
    }>().req;

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    try {
      request.user = this.jwtService.verify<AuthUser>(token);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

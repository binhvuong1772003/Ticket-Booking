import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';

type JwtPayload = { sub?: unknown; [key: string]: unknown };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext) {
    const request = GqlExecutionContext.create(context)
      .getContext<{ req: { headers: { authorization?: string }; user?: JwtPayload } }>().req;
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing access token');

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw new Error('Missing subject');
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

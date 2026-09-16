import { config } from 'dotenv';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';

config({ path: 'apps/api-gateway/.env' });

type JwtPayload = {
  sub: string;
  role: string;
  iat?: number;
  exp?: number;
};

type AuthenticatedRequest = Request & {
  user?: JwtPayload;
};

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured');
}

const jwtService = new JwtService({
  secret: jwtSecret,
});

export function jwtMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const authorization = req.headers.authorization;

  if (!authorization) {
    return next();
  }

  const [scheme, token] = authorization.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      message: 'Invalid authorization header',
    });
  }

  try {
    const payload = jwtService.verify<JwtPayload>(token);

    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({
      message: 'Invalid or expired token',
    });
  }
}

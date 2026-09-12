import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthResolver } from './auth.resolver.js';
import { TokenService } from './services/token.service.js';
import { AuthService } from './services/auth.service.js';
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured');
}

@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret,
      signOptions: {
        expiresIn: '15m',
      },
    }),
  ],
  providers: [AuthResolver, TokenService, AuthService],
  exports: [TokenService],
})
export class AuthModule {}

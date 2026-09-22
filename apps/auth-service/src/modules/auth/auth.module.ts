import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { AuthResolver } from './presentation/graphql/auth.resolver.js';
import { TokenService } from './application/services/token.service.js';
import { AuthService } from './application/services/auth.service.js';
import { GoogleAuthController } from '../oauth/google/google-auth.controller.js';
import { GoogleAuthService } from '../oauth/google/google-auth.service.js';
import { AdminGuard } from './presentation/graphql/guards/admin.guard.js';
import { JwtAuthGuard } from './presentation/graphql/guards/jwt-auth.guard.js';

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured');
}

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: {
            brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
          },
          consumer: {
            groupId: 'auth-service-producer',
          },
        },
      },
    ]),
    JwtModule.register({
      secret: jwtSecret,
      signOptions: {
        expiresIn: '15m',
      },
    }),
  ],
  controllers: [GoogleAuthController],
  providers: [
    AuthResolver,
    TokenService,
    AuthService,
    GoogleAuthService,
    AdminGuard,
    JwtAuthGuard,
  ],
  exports: [TokenService],
})
export class AuthModule {}

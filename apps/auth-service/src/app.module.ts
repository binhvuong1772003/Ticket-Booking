import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { AuthModule } from './auth/auth.module.js';
import { ApiError } from './common/errors/api-error.js';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
      },
    }),
    AuthModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          exceptionFactory: (errors) =>
            new ApiError('Input validation failed', {
              code: 'BAD_USER_INPUT',
              details: {
                fields: errors.map((error) => ({
                  field: error.property,
                  messages: Object.values(error.constraints ?? {}),
                })),
              },
            }),
        }),
    },
  ],
})
export class AppModule {}

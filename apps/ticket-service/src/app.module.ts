import { Module } from '@nestjs/common';
import { config } from 'dotenv';
import { JwtModule } from '@nestjs/jwt';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { TicketServiceModule } from './modules/ticket/ticket.module';

config({ path: 'apps/ticket-service/.env' });

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is not configured');
}

@Module({
  imports: [
    JwtModule.register({ global: true, secret: jwtSecret }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2 },
      context: ({ req }: { req: any }) => ({ req }),
    }),
    TicketServiceModule,
  ],
})
export class AppModule {}

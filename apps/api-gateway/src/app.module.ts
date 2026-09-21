import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';
import { GoogleOAuthController } from './modules/oauth/google-oauth.controller.js';

const observeAppKey = process.env.OBSERVE_APP_KEY?.trim();
const observeAppSecret = process.env.OBSERVE_APP_SECRET?.trim();
const observeEnabled = Boolean(observeAppKey && observeAppSecret);
const authServiceUrl =
  process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001/graphql';
const eventServiceUrl =
  process.env.EVENT_SERVICE_URL ?? 'http://localhost:4003/graphql';
const bookingServiceUrl =
  process.env.BOOKING_SERVICE_URL ?? 'http://localhost:4002/graphql';

export const { ObserveModule, ObserveInstrument } = createObserveModule();
class AuthenticatedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }: { request: any; context: any }) {
    const authorization = context?.req?.headers.authorization;
    const cookie = context?.req?.headers.cookie;

    if (authorization) {
      request.http?.headers.set('authorization', authorization);
    }

    if (cookie) {
      request.http?.headers.set('cookie', cookie);
    }
  }

  didReceiveResponse({ response, context }: { response: any; context: any }) {
    const headers = response.http?.headers;
    const cookies =
      headers?.getSetCookie?.() ??
      (headers?.get?.('set-cookie') ? [headers.get('set-cookie')] : []);

    for (const cookie of cookies) {
      context?.res?.append('set-cookie', cookie);
    }

    return response;
  }
}
@Module({
  imports: [
    ...(observeEnabled
      ? [
          ObserveModule.forRoot({
            appKey: observeAppKey!,
            appSecret: observeAppSecret!,
            serviceId: process.env.OBSERVE_SERVICE_ID ?? 'ticket-booking',
          }),
        ]
      : []),
    GraphQLModule.forRoot<ApolloGatewayDriverConfig>({
      driver: ApolloGatewayDriver,
      server: {
        context: ({ req, res }: { req: any; res: any }) => ({
          req,
          res,
        }),
      },
      gateway: {
        buildService({ url }) {
          return new AuthenticatedDataSource({ url });
        },
        supergraphSdl: new IntrospectAndCompose({
          // Subgraphs có thể chưa listen khi gateway boot cùng lúc —
          // poll để retry thay vì crash
          pollIntervalInMs: 10_000,
          subgraphs: [
            {
              name: 'auth',
              url: authServiceUrl,
            },
            {
              name: 'events',
              url: eventServiceUrl,
            },
            {
              name: 'booking',
              url: bookingServiceUrl,
            },
          ],
        }),
      },
    }),
  ],
  controllers: [GoogleOAuthController],
})
export class AppModule {}

export { observeEnabled };

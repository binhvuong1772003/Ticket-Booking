import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { IntrospectAndCompose } from '@apollo/gateway';

const observeAppKey = process.env.OBSERVE_APP_KEY?.trim();
const observeAppSecret = process.env.OBSERVE_APP_SECRET?.trim();
const observeEnabled = Boolean(observeAppKey && observeAppSecret);
const authServiceUrl =
  process.env.AUTH_SERVICE_URL ?? 'http://localhost:4001/graphql';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

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

      gateway: {
        supergraphSdl: new IntrospectAndCompose({
          subgraphs: [
            {
              name: 'auth',
              url: authServiceUrl,
            },
            // {
            //   name: 'booking',
            //   url: 'http://localhost:4002/graphql',
            // },
          ],
        }),
      },
    }),
  ],
})
export class AppModule {}

export { observeEnabled };

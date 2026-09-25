import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { PaymentService } from './application/payment.service';
import { StripeService } from './application/stripe.service';
import { OutboxProcessor } from './infrastructure/outbox.processor';
import { PaymentRepository } from './infrastructure/payment.repository';
import { RefundProcessor } from './infrastructure/refund.processor';
import { RefundQueue } from './infrastructure/refund.queue';
import { PaymentController } from './presentation/grpc/payment.controller';
import { StripeWebhookController } from './presentation/http/stripe-webhook.controller';

@Module({
  imports: [
    PrismaModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6380),
      },
    }),
    BullModule.registerQueue({ name: 'refund' }),
    ClientsModule.register([
      {
        name: 'PAYMENT_KAFKA',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'payment-service',
            brokers: [process.env.KAFKA_BROKERS || 'localhost:9092'],
          },
        },
      },
    ]),
  ],
  controllers: [PaymentController, StripeWebhookController],
  providers: [
    PaymentService,
    StripeService,
    PaymentRepository,
    OutboxProcessor,
    RefundQueue,
    RefundProcessor,
  ],
})
export class PaymentModule {}

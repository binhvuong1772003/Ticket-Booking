import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { Prisma } from '../../../generated/payment-prisma';
import { PaymentRepository } from '../infrastructure/payment.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { CreateCheckoutInput, StripeService } from './stripe.service';

const EVENT_TOPIC: Record<string, string> = {
  'checkout.session.completed': 'payment.succeeded',
  'checkout.session.expired': 'payment.expired',
  'payment_intent.payment_failed': 'payment.failed',
};

const TOPIC_STATUS: Record<string, 'SUCCEEDED' | 'EXPIRED' | 'FAILED'> = {
  'payment.succeeded': 'SUCCEEDED',
  'payment.expired': 'EXPIRED',
  'payment.failed': 'FAILED',
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly repository: PaymentRepository,
    private readonly outbox: OutboxProcessor,
  ) {}

  async createCheckout(input: CreateCheckoutInput) {
    const session = await this.stripeService.createCheckout(input);
    await this.repository.create({
      bookingId: input.bookingId,
      checkoutSessionId: session.id,
      organizerAccountId: input.organizerAccountId || undefined,
      amount: input.amount * input.quantity,
      currency: input.currency,
    });
    return session;
  }

  async processStripeEvent(event: Stripe.Event) {
    const topic = EVENT_TOPIC[event.type];
    if (!topic) {
      return { received: true, ignored: event.type };
    }

    const data = event.data.object as
      Stripe.Checkout.Session | Stripe.PaymentIntent;
    const bookingId =
      'metadata' in data && data.metadata
        ? data.metadata.booking_id
        : undefined;
    if (!bookingId) {
      return { received: true, ignored: 'no booking_id in metadata' };
    }

    const payload: Record<string, unknown> = {
      booking_id: bookingId,
      stripe_object_id: data.id,
      stripe_event_id: event.id,
    };

    let paymentIntentId: string | undefined;
    if (event.type === 'checkout.session.completed') {
      const session = data as Stripe.Checkout.Session;
      paymentIntentId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
      payload.payment_intent_id = paymentIntentId;
      payload.amount_total = session.amount_total;
      payload.currency = session.currency;
    } else if (event.type === 'payment_intent.payment_failed') {
      paymentIntentId = data.id;
    }

    const payment = await this.repository.findByStripeRef({
      checkoutSessionId: event.type.startsWith('checkout.session.')
        ? data.id
        : undefined,
      paymentIntentId,
      bookingId,
    });

    try {
      await this.repository.recordWebhookEvent({
        paymentId: payment?.id,
        status: payment ? TOPIC_STATUS[topic] : undefined,
        paymentIntentId,
        stripeEventId: event.id,
        eventType: topic,
        payload,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.logger.log(`Duplicate Stripe event ${event.id}, skipped`);
        return { received: true, duplicate: true };
      }
      throw error;
    }

    this.outbox.wake();
    return { received: true };
  }
}

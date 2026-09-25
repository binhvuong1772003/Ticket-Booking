import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import Stripe from 'stripe';

export type CreateCheckoutInput = {
  bookingId: string;
  userId?: string;
  amount: number;
  currency: string;
  organizerAccountId: string;
  quantity: number;
  ticketTypeName: string;
  successUrl: string;
};

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set');
    }
    this.stripe = new Stripe(key);
  }

  async createCheckout(input: CreateCheckoutInput) {
    try {
      const session = await this.stripe.checkout.sessions.create({
        ui_mode: 'embedded',
        mode: 'payment',
        line_items: [
          {
            quantity: input.quantity,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amount,
              product_data: {
                name: input.ticketTypeName,
              },
            },
          },
        ],
        payment_intent_data: {
          // ponytail: organizer Connect account chưa onboard — trống thì
          // platform nhận toàn bộ charge, split fee theo Platform Pricing sau
          ...(input.organizerAccountId
            ? { transfer_data: { destination: input.organizerAccountId } }
            : {}),
          metadata: {
            booking_id: input.bookingId,
          },
        },
        metadata: {
          booking_id: input.bookingId,
        },
        return_url:
          input.successUrl ||
          process.env.CHECKOUT_RETURN_URL ||
          'http://localhost:3000/checkout/return',
      });
      return session;
    } catch (error) {
      throw new RpcException({
        code: 13,
        message:
          error instanceof Error
            ? `Stripe checkout failed: ${error.message}`
            : 'Stripe checkout failed',
      });
    }
  }

  async refund(paymentIntentId: string, idempotencyKey: string) {
    try {
      return await this.stripe.refunds.create(
        { payment_intent: paymentIntentId },
        { idempotencyKey },
      );
    } catch (error) {
      throw new RpcException({
        code: 13,
        message:
          error instanceof Error
            ? `Stripe refund failed: ${error.message}`
            : 'Stripe refund failed',
      });
    }
  }

  constructWebhookEvent(payload: Buffer, signature: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    }
    try {
      return this.stripe.webhooks.constructEvent(payload, signature, secret);
    } catch {
      throw new Error('Invalid Stripe webhook signature');
    }
  }
}

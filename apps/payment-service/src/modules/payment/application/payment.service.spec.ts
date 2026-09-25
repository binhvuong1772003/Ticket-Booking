import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import type Stripe from 'stripe';
import { Prisma } from '../../../generated/payment-prisma';
import { PaymentService } from './payment.service';
import { StripeService } from './stripe.service';
import { PaymentRepository } from '../infrastructure/payment.repository';
import { OutboxProcessor } from '../infrastructure/outbox.processor';
import { RefundQueue } from '../infrastructure/refund.queue';

const event = (overrides: Partial<Stripe.Event> = {}): Stripe.Event =>
  ({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_123',
        payment_intent: 'pi_123',
        amount_total: 50000,
        currency: 'usd',
        metadata: { booking_id: 'booking-1' },
      },
    },
    ...overrides,
  }) as Stripe.Event;

describe('PaymentService.processStripeEvent', () => {
  let service: PaymentService;
  const findByStripeRef = vi.fn();
  const recordWebhookEvent = vi.fn();
  const wake = vi.fn();
  const enqueue = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: StripeService, useValue: {} },
        {
          provide: PaymentRepository,
          useValue: { findByStripeRef, recordWebhookEvent },
        },
        { provide: OutboxProcessor, useValue: { wake } },
        { provide: RefundQueue, useValue: { enqueue } },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  it('ignores unmapped event types', async () => {
    const result = await service.processStripeEvent(
      event({ type: 'customer.created' }),
    );
    expect(result).toEqual({ received: true, ignored: 'customer.created' });
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('ignores events without booking_id metadata', async () => {
    const e = event();
    (e.data.object as Stripe.Checkout.Session).metadata = {};
    const result = await service.processStripeEvent(e);
    expect(result).toEqual({
      received: true,
      ignored: 'no booking_id in metadata',
    });
    expect(recordWebhookEvent).not.toHaveBeenCalled();
  });

  it('records event and wakes outbox on success', async () => {
    findByStripeRef.mockResolvedValue({ id: 'pay-1' });
    recordWebhookEvent.mockResolvedValue(undefined);

    const result = await service.processStripeEvent(event());

    expect(result).toEqual({ received: true });
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'pay-1',
        status: 'SUCCEEDED',
        paymentIntentId: 'pi_123',
        stripeEventId: 'evt_1',
        eventType: 'payment.succeeded',
      }),
    );
    expect(wake).toHaveBeenCalled();
  });

  it('emits outbox even when no matching payment exists', async () => {
    findByStripeRef.mockResolvedValue(null);
    recordWebhookEvent.mockResolvedValue(undefined);

    const result = await service.processStripeEvent(event());

    expect(result).toEqual({ received: true });
    expect(recordWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: undefined, status: undefined }),
    );
  });

  it('returns duplicate on repeated Stripe event ids (P2002)', async () => {
    findByStripeRef.mockResolvedValue({ id: 'pay-1' });
    recordWebhookEvent.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '6.19.0',
      }),
    );

    const result = await service.processStripeEvent(event());

    expect(result).toEqual({ received: true, duplicate: true });
    expect(wake).not.toHaveBeenCalled();
  });
});

describe('PaymentService.refund', () => {
  let service: PaymentService;
  const findByStripeRef = vi.fn();
  const requestRefund = vi.fn();
  const enqueue = vi.fn();

  const payment = {
    id: 'pay-1',
    bookingId: 'booking-1',
    paymentIntentId: 'pi_123',
    status: 'SUCCEEDED',
    stripeRefundId: null,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    findByStripeRef.mockResolvedValue(payment);
    requestRefund.mockResolvedValue({ count: 1 });
    enqueue.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentService,
        { provide: StripeService, useValue: {} },
        {
          provide: PaymentRepository,
          useValue: { findByStripeRef, requestRefund },
        },
        { provide: OutboxProcessor, useValue: {} },
        { provide: RefundQueue, useValue: { enqueue } },
      ],
    }).compile();

    service = module.get(PaymentService);
  });

  it('records intent and enqueues job for a succeeded payment', async () => {
    const result = await service.refund({ bookingId: 'booking-1' });

    expect(result).toEqual({
      accepted: true,
      refunded: false,
      refundId: '',
    });
    expect(requestRefund).toHaveBeenCalledWith('pay-1');
    expect(enqueue).toHaveBeenCalledWith('pay-1');
  });

  it('still accepts when enqueue fails (backstop re-enqueues)', async () => {
    enqueue.mockRejectedValue(new Error('redis down'));

    const result = await service.refund({ bookingId: 'booking-1' });

    expect(result.accepted).toBe(true);
  });

  it('returns refunded for an already-refunded payment', async () => {
    findByStripeRef.mockResolvedValue({
      ...payment,
      status: 'REFUNDED',
      stripeRefundId: 're_1',
    });

    const result = await service.refund({ bookingId: 'booking-1' });

    expect(result).toEqual({
      accepted: true,
      refunded: true,
      refundId: 're_1',
    });
    expect(requestRefund).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects refund for a non-succeeded payment', async () => {
    findByStripeRef.mockResolvedValue({ ...payment, status: 'CREATED' });

    await expect(service.refund({ bookingId: 'booking-1' })).rejects.toThrow();
    expect(requestRefund).not.toHaveBeenCalled();
  });

  it('rejects when no payment/payment intent exists', async () => {
    findByStripeRef.mockResolvedValue(null);

    await expect(service.refund({ bookingId: 'booking-1' })).rejects.toThrow();
  });
});

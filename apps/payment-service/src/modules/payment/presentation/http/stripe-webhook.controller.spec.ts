import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from '../../application/stripe.service';
import { PaymentService } from '../../application/payment.service';

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  const constructWebhookEvent = vi.fn();
  const processStripeEvent = vi.fn();

  const req = (rawBody?: Buffer) =>
    ({ rawBody }) as Parameters<StripeWebhookController['handle']>[0];

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        { provide: StripeService, useValue: { constructWebhookEvent } },
        { provide: PaymentService, useValue: { processStripeEvent } },
      ],
    }).compile();

    controller = module.get(StripeWebhookController);
  });

  it('rejects requests without a raw body', async () => {
    await expect(controller.handle(req(), 'sig')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects invalid signatures', async () => {
    constructWebhookEvent.mockImplementation(() => {
      throw new Error('Invalid Stripe webhook signature');
    });
    await expect(
      controller.handle(req(Buffer.from('{}')), 'bad'),
    ).rejects.toThrow(UnauthorizedException);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it('delegates verified events to PaymentService', async () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed' };
    constructWebhookEvent.mockReturnValue(event);
    processStripeEvent.mockResolvedValue({ received: true });

    const result = await controller.handle(req(Buffer.from('{}')), 'sig');

    expect(processStripeEvent).toHaveBeenCalledWith(event);
    expect(result).toEqual({ received: true });
  });
});

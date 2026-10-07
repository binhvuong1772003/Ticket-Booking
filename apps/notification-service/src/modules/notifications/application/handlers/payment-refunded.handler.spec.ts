import { describe, expect, it, vi } from 'vitest';
import { PaymentRefundedEmailHandler } from './payment-refunded.handler';

const refunded = (eventId = 'event-1', user_id?: string) => ({
  eventId,
  eventType: 'payment.refunded' as const,
  occurredAt: '2026-10-01T12:00:00.000Z',
  payload: { booking_id: 'booking-1', user_id, amount: 12, currency: 'USD' },
});

const setup = (status = 'QUEUED') => {
  const repository = {
    createOrGet: vi.fn().mockResolvedValue({ id: 'delivery-1', status }),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  return {
    handler: new PaymentRefundedEmailHandler(queue as any, repository as any),
    repository,
    queue,
  };
};

describe('PaymentRefundedEmailHandler', () => {
  it('persists before enqueueing only the delivery ID', async () => {
    const ctx = setup();
    await ctx.handler.handlePaymentRefunded(refunded('event-1', 'user-1'));
    expect(ctx.repository.createOrGet).toHaveBeenCalledWith({
      kind: 'REFUND',
      eventId: 'event-1',
      payload: {
        bookingId: 'booking-1',
        userId: 'user-1',
        amount: 12,
        currency: 'USD',
      },
    });
    expect(ctx.queue.add).toHaveBeenCalledWith(
      'refund-email',
      { deliveryId: 'delivery-1' },
      {
        jobId: 'notification-email-delivery-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  it('does not enqueue an already sent intent after replay', async () => {
    const ctx = setup('SENT');
    await ctx.handler.handlePaymentRefunded(refunded('event-1', 'user-1'));
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue a terminally failed intent after replay', async () => {
    const ctx = setup('FAILED');
    await ctx.handler.handlePaymentRefunded(refunded('event-1', 'user-1'));
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('preserves warning/no-email behavior when user_id is absent', async () => {
    const ctx = setup();
    await ctx.handler.handlePaymentRefunded(refunded());
    expect(ctx.repository.createOrGet).not.toHaveBeenCalled();
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('rejects database failures before enqueue', async () => {
    const ctx = setup();
    ctx.repository.createOrGet.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      ctx.handler.handlePaymentRefunded(refunded('event-1', 'user-1')),
    ).rejects.toThrow('database unavailable');
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('rejects enqueue failures while leaving the persisted intent', async () => {
    const ctx = setup();
    ctx.queue.add.mockRejectedValue(new Error('redis unavailable'));
    await expect(
      ctx.handler.handlePaymentRefunded(refunded('event-1', 'user-1')),
    ).rejects.toThrow('redis unavailable');
    expect(ctx.repository.createOrGet).toHaveBeenCalledOnce();
  });
});

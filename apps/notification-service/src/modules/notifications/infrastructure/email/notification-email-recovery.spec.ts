import { describe, expect, it, vi } from 'vitest';
import { NotificationEmailRecovery } from './notification-email-recovery';

describe('NotificationEmailRecovery', () => {
  it('sweeps queued rows at startup and every 15 seconds using stable ID-only jobs', async () => {
    vi.useFakeTimers();
    const deliveries = {
      recoverable: vi.fn().mockResolvedValue([{ id: 'delivery-1' }]),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const recovery = new NotificationEmailRecovery(
      deliveries as any,
      queue as any,
    );
    await recovery.onModuleInit();
    expect(deliveries.recoverable).toHaveBeenCalledWith(100);
    expect(queue.add).toHaveBeenCalledWith(
      'notification-email',
      { deliveryId: 'delivery-1' },
      expect.objectContaining({
        jobId: 'notification-email-delivery-1',
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deliveries.recoverable).toHaveBeenCalledTimes(2);
    await recovery.onModuleDestroy();
    vi.useRealTimers();
  });

  it('leaves enqueue failures retryable for the next poll', async () => {
    vi.useFakeTimers();
    const deliveries = {
      recoverable: vi.fn().mockResolvedValue([{ id: 'delivery-1' }]),
    };
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error('redis down'))
        .mockResolvedValue(undefined),
    };
    const recovery = new NotificationEmailRecovery(
      deliveries as any,
      queue as any,
    );
    await recovery.sweep();
    await recovery.sweep();
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][1]).toEqual({ deliveryId: 'delivery-1' });
    await recovery.onModuleDestroy();
    vi.useRealTimers();
  });

  it('retries a failed recovery query on the next sweep', async () => {
    const deliveries = {
      recoverable: vi
        .fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue([{ id: 'delivery-2' }]),
    };
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    const recovery = new NotificationEmailRecovery(
      deliveries as any,
      queue as any,
    );
    await recovery.sweep();
    await recovery.sweep();
    expect(deliveries.recoverable).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'notification-email',
      { deliveryId: 'delivery-2' },
      expect.any(Object),
    );
  });

  it('does not overlap a slow sweep with the next timer tick', async () => {
    let finish!: (rows: Array<{ id: string }>) => void;
    const deliveries = {
      recoverable: vi.fn(
        () =>
          new Promise<Array<{ id: string }>>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const recovery = new NotificationEmailRecovery(
      deliveries as any,
      { add: vi.fn() } as any,
    );
    const first = recovery.sweep();
    await Promise.resolve();
    await recovery.sweep();
    expect(deliveries.recoverable).toHaveBeenCalledTimes(1);
    finish([]);
    await first;
  });
});

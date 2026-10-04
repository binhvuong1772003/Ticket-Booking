import { describe, expect, it, vi } from 'vitest';
import { UserRegisteredEmailHandler } from './user-registered.handler';

const registered = (eventId = 'event-1') => ({
  eventId,
  eventType: 'auth.user.registered' as const,
  occurredAt: '2026-10-01T12:00:00.000Z',
  payload: {
    userId: 'user-1',
    email: 'user@example.test',
    createdAt: '2026-10-01T12:00:00.000Z',
    verificationToken: 'secret-token',
  },
});

const setup = (status = 'QUEUED') => {
  const repository = {
    createOrGet: vi.fn().mockResolvedValue({ id: 'delivery-1', status }),
  };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  return {
    handler: new UserRegisteredEmailHandler(queue as any, repository as any),
    repository,
    queue,
  };
};

describe('UserRegisteredEmailHandler', () => {
  it('persists the token with a 24-hour expiry and enqueues only the delivery ID', async () => {
    const ctx = setup();
    await ctx.handler.handleUserRegistered(registered());
    expect(ctx.repository.createOrGet).toHaveBeenCalledWith({
      kind: 'VERIFICATION',
      eventId: 'event-1',
      payload: { to: 'user@example.test', verificationToken: 'secret-token' },
      expiresAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    expect(ctx.queue.add).toHaveBeenCalledWith(
      'verification-email',
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
    await ctx.handler.handleUserRegistered(registered());
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('does not enqueue a terminally failed intent after replay', async () => {
    const ctx = setup('FAILED');
    await ctx.handler.handleUserRegistered(registered());
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a fresh verification event ID', async () => {
    const ctx = setup();
    ctx.repository.createOrGet.mockResolvedValue({
      id: 'delivery-2',
      status: 'QUEUED',
    });
    await ctx.handler.handleUserRegistered(registered('event-2'));
    expect(ctx.repository.createOrGet).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-2' }),
    );
    expect(ctx.queue.add).toHaveBeenCalledWith(
      'verification-email',
      { deliveryId: 'delivery-2' },
      expect.any(Object),
    );
  });

  it('rejects database failures before enqueue', async () => {
    const ctx = setup();
    ctx.repository.createOrGet.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      ctx.handler.handleUserRegistered(registered()),
    ).rejects.toThrow('database unavailable');
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('rejects enqueue failures while leaving the persisted intent', async () => {
    const ctx = setup();
    ctx.queue.add.mockRejectedValue(new Error('redis unavailable'));
    await expect(
      ctx.handler.handleUserRegistered(registered()),
    ).rejects.toThrow('redis unavailable');
    expect(ctx.repository.createOrGet).toHaveBeenCalledOnce();
  });
});

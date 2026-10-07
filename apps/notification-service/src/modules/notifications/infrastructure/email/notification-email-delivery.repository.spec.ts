import { describe, expect, it, vi } from 'vitest';
import { NotificationEmailDeliveryRepository } from './notification-email-delivery.repository';
import { encryptToken } from './notification-email-crypto';

const key = 'a'.repeat(64);
process.env.NOTIFICATION_EMAIL_PAYLOAD_KEY = key;
const verification = {
  to: 'a@example.test',
  verificationToken: 'secret-token',
};
const refund = {
  bookingId: 'booking-1',
  userId: 'user-1',
  amount: 12,
  currency: 'USD',
};
const repo = (prisma: any) => new NotificationEmailDeliveryRepository(prisma);

describe('NotificationEmailDeliveryRepository', () => {
  it('deduplicates by kind and event ID without replacing the first payload', async () => {
    const upsert = vi.fn().mockResolvedValue({
      id: 'id-1',
      kind: 'VERIFICATION',
      status: 'QUEUED',
    });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'id-1',
        kind: 'VERIFICATION',
        status: 'QUEUED',
      })
      .mockResolvedValue(null);
    const repository = repo({
      notificationEmailDelivery: { upsert, findUnique },
    });
    const input = {
      kind: 'VERIFICATION' as const,
      eventId: 'evt-1',
      payload: verification,
    };
    await repository.createOrGet(input);
    await repository.createOrGet({
      ...input,
      payload: { ...verification, verificationToken: '' },
    });
    await repository.createOrGet({ ...input, eventId: 'evt-2' });
    await repository.createOrGet({ ...input, kind: 'REFUND', payload: refund });
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls.map(([call]) => call.where.dedupKey)).toEqual([
      'verification:evt-1',
      'verification:evt-2',
      'refund:evt-1',
    ]);
    expect(JSON.stringify(upsert.mock.calls[0][0].create)).not.toContain(
      'secret-token',
    );
  });

  it('rejects an invalid persisted status instead of returning it as a valid state', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'id-1',
      kind: 'VERIFICATION',
      status: 'CORRUPT',
    });
    const repository = repo({ notificationEmailDelivery: { findUnique } });
    await expect(
      repository.createOrGet({
        kind: 'VERIFICATION',
        eventId: 'evt-1',
        payload: verification,
      }),
    ).rejects.toThrow('Invalid notification email delivery status: CORRUPT');
  });

  it('rejects an invalid persisted kind instead of returning it as a valid delivery', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'id-1', kind: 'UNKNOWN', status: 'QUEUED' });
    const repository = repo({ notificationEmailDelivery: { findUnique } });
    await expect(
      repository.createOrGet({
        kind: 'VERIFICATION',
        eventId: 'evt-1',
        payload: verification,
      }),
    ).rejects.toThrow('Invalid notification email delivery kind: UNKNOWN');
  });

  it('allows one claimant and gives the winner a lease token', async () => {
    let leaseId: string | undefined;
    const updateMany = vi.fn().mockImplementation(({ where, data }) => {
      if (where.attempts?.gte) return { count: 0 };
      if (where.attempts?.lt) {
        if (leaseId) return { count: 0 };
        leaseId = data.leaseId;
        return { count: 1 };
      }
      return { count: 1 };
    });
    const findUnique = vi.fn().mockImplementation(() => ({
      id: 'id-1',
      kind: 'VERIFICATION',
      leaseId,
      status: 'SENDING',
      payload: {
        to: verification.to,
        verificationTokenCiphertext: encryptToken(
          verification.verificationToken,
          Buffer.from(key, 'hex'),
        ),
      },
      attempts: 1,
      expiresAt: null,
    }));
    const repository = repo({
      notificationEmailDelivery: { updateMany, findUnique },
    });
    const first = await repository.claim('id-1');
    const second = await repository.claim('id-1');
    expect(first?.delivery.payload).toEqual(verification);
    expect(first?.leaseId).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect(updateMany.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it('does not return a claim if another lease replaced it before the read', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      id: 'id-1',
      kind: 'REFUND',
      leaseId: 'newer-lease',
      status: 'SENDING',
    });
    const repository = repo({
      notificationEmailDelivery: { updateMany, findUnique },
    });
    expect(await repository.claim('id-1')).toBeNull();
  });

  it('reads the winning intent after a concurrent unique-key insert', async () => {
    const upsert = vi.fn().mockRejectedValue({ code: 'P2002' });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'winner', kind: 'REFUND', status: 'SENT' });
    const repository = repo({
      notificationEmailDelivery: { upsert, findUnique },
    });
    await expect(
      repository.createOrGet({
        kind: 'REFUND',
        eventId: 'evt-race',
        payload: refund,
      }),
    ).resolves.toEqual({ id: 'winner', status: 'SENT' });
  });

  it('conditions terminal transitions on the active lease and erases payload', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const repository = repo({ notificationEmailDelivery: { updateMany } });
    expect(await repository.markSent('id-1', 'stale-lease', '<id>')).toBe(
      false,
    );
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'id-1',
      status: 'SENDING',
      leaseId: 'stale-lease',
    });
    expect(await repository.markFailure('id-1', 'lease-1', 'SMTP', true)).toBe(
      true,
    );
    expect(updateMany.mock.calls[1][0].data).toMatchObject({
      status: 'FAILED',
      payload: null,
      leaseUntil: null,
    });
  });

  it('lists queued and expired lease IDs without mutating an active worker lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([{ id: 'id-1' }]);
    const repository = repo({
      notificationEmailDelivery: { updateMany, findMany },
    });
    expect(await repository.recoverable(20)).toEqual([{ id: 'id-1' }]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { status: 'QUEUED' },
      { status: 'SENDING', leaseUntil: { lte: expect.any(Date) } },
    ]);
    expect(findMany.mock.calls[0][0].take).toBe(20);
    await repository.markSent('id-1', 'original-lease', '<id>');
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'id-1',
      status: 'SENDING',
      leaseId: 'original-lease',
    });
  });

  it('terminally fails exhausted queued deliveries before they can be claimed', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const repository = repo({ notificationEmailDelivery: { updateMany } });
    expect(await repository.claim('id-1')).toBeNull();
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'id-1',
        attempts: { gte: 5 },
        OR: [
          { status: 'QUEUED' },
          { status: 'SENDING', leaseUntil: { lte: expect.any(Date) } },
        ],
      },
      data: {
        status: 'FAILED',
        payload: null,
        lastErrorCode: 'ATTEMPTS_EXHAUSTED',
      },
    });
    expect(updateMany.mock.calls[1][0].where.attempts).toEqual({ lt: 5 });
  });

  it('terminally fails a claimed row whose payload is missing', async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const findUnique = vi.fn().mockImplementation(({ where }) => ({
      id: where.id,
      kind: 'REFUND',
      status: 'SENDING',
      leaseId: updateMany.mock.calls[1][0]?.data.leaseId,
      attempts: 1,
      payload: null,
    }));
    const repository = repo({
      notificationEmailDelivery: { updateMany, findUnique },
    });
    expect(await repository.claim('id-1')).toBeNull();
    expect(updateMany.mock.calls[2][0].data).toMatchObject({
      status: 'FAILED',
      payload: null,
      lastErrorCode: 'PAYLOAD_MISSING',
    });
  });

  it('requeues invalid encrypted payloads until the fifth claim, then marks them terminal', async () => {
    let attempts = 3;
    let activeLease: string | null = null;
    const updateMany = vi.fn().mockImplementation(({ where, data }) => {
      if (where.attempts?.gte)
        return { count: attempts >= where.attempts.gte ? 1 : 0 };
      if (where.attempts?.lt) {
        if (attempts >= where.attempts.lt) return { count: 0 };
        attempts += 1;
        activeLease = data.leaseId;
        return { count: 1 };
      }
      return { count: where.leaseId === activeLease ? 1 : 0 };
    });
    const findUnique = vi.fn().mockImplementation(() => ({
      id: 'id-1',
      kind: 'VERIFICATION',
      status: 'SENDING',
      leaseId: activeLease,
      attempts,
      payload: { to: verification.to, verificationTokenCiphertext: 'broken' },
    }));
    const repository = repo({
      notificationEmailDelivery: { updateMany, findUnique },
    });
    expect(await repository.claim('id-1')).toBeNull();
    expect(updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'QUEUED',
      lastErrorCode: 'PAYLOAD_INVALID',
    });
    expect(await repository.claim('id-1')).toBeNull();
    expect(updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'FAILED',
      payload: null,
      lastErrorCode: 'PAYLOAD_INVALID',
    });
  });
});

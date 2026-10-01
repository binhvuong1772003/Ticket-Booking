import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryRepository } from './email-delivery.repository';

describe('EmailDeliveryRepository', () => {
  it('uses one conditional database update as the delivery lease', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new EmailDeliveryRepository({
      emailDelivery: { updateMany },
    } as any);
    expect(await repository.claim('delivery-1')).toBe(false);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        id: 'delivery-1',
        OR: [
          { status: 'QUEUED' },
          { status: 'SENDING', leaseUntil: { lte: expect.any(Date) } },
        ],
      },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        leaseUntil: expect.any(Date),
      },
    });
  });

  it('allows one initial resend and only updates its cooldown after 60 seconds', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002' });
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const repository = new EmailDeliveryRepository({
      ticketEmailCooldown: { create, updateMany },
    } as any);
    expect(await repository.reserveResend('user-1', 'ticket-1')).toBe(false);
    expect(updateMany.mock.calls[0][0].where.requestedAt.lte).toBeInstanceOf(
      Date,
    );
    expect(await repository.reserveResend('user-1', 'ticket-1')).toBe(true);
  });
});

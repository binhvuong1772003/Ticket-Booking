import { describe, expect, it, vi } from 'vitest';
import { BookingRepository } from './booking.repository';

describe('BookingRepository.updateRecipientIfPending', () => {
  it('uses one owner and pending-state conditional write', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repository = new BookingRepository({ booking: { updateMany } } as any);
    const now = new Date();
    await repository.updateRecipientIfPending(
      'booking-1', 'buyer-1', 'Recipient', 'recipient@example.test', now,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'booking-1', userId: 'buyer-1', status: 'PENDING', paymentStatus: 'PENDING',
        expiresAt: { gt: now },
      },
      data: {
        recipientFullName: 'Recipient', recipientEmail: 'recipient@example.test',
      },
    });
  });
});

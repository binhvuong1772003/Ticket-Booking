import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BookingService } from './booking.service';

const makeService = (booking = { id: 'booking-1', userId: 'buyer-1', status: 'PENDING' }) => {
  const changed = vi.fn().mockResolvedValue({ count: 1 });
  const findById = vi.fn().mockResolvedValue(booking);
  const repository = { updateRecipientIfPending: changed, findById };
  const grpc = { getService: vi.fn() };
  return { service: new BookingService(grpc as any, grpc as any, repository as any, {} as any), changed, findById };
};

describe('BookingService recipient contact', () => {
  it('normalizes and persists buyer-edited contact while pending', async () => {
    const ctx = makeService();
    await ctx.service.updateBookingContact(
      'booking-1',
      { fullName: '  Jamie Buyer  ', email: ' Jamie@Example.Test ' },
      'buyer-1',
    );
    expect(ctx.changed).toHaveBeenCalledWith(
      'booking-1', 'buyer-1', 'Jamie Buyer', 'jamie@example.test', expect.any(Date),
    );
  });

  it('rejects malformed contact before writing', async () => {
    const ctx = makeService();
    await expect(ctx.service.updateBookingContact(
      'booking-1', { fullName: 'Buyer', email: 'bad-email' }, 'buyer-1',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.changed).not.toHaveBeenCalled();
  });

  it('requires at least two name characters and caps email length', async () => {
    const ctx = makeService();
    await expect(ctx.service.updateBookingContact(
      'booking-1', { fullName: 'A', email: 'buyer@example.test' }, 'buyer-1',
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctx.service.updateBookingContact(
      'booking-1', { fullName: 'Buyer', email: `${'a'.repeat(243)}@example.test` }, 'buyer-1',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.changed).not.toHaveBeenCalled();
  });

  it('hides another buyer booking when the conditional update affects no row', async () => {
    const ctx = makeService({ id: 'booking-1', userId: 'someone-else', status: 'PENDING' });
    ctx.changed.mockResolvedValue({ count: 0 });
    await expect(ctx.service.updateBookingContact(
      'booking-1', { fullName: 'Buyer', email: 'buyer@example.test' }, 'buyer-1',
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not update contact once payment is no longer pending', async () => {
    const ctx = makeService({ id: 'booking-1', userId: 'buyer-1', status: 'CONFIRMING' });
    ctx.changed.mockResolvedValue({ count: 0 });
    await expect(ctx.service.updateBookingContact(
      'booking-1', { fullName: 'Buyer', email: 'buyer@example.test' }, 'buyer-1',
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns only the trusted recipient projection', async () => {
    const ctx = makeService({
      id: 'booking-1', userId: 'buyer-1', recipientFullName: 'Recipient',
      recipientEmail: 'recipient@example.test', privateField: 'never expose',
    });
    await expect(ctx.service.internalBookingRecipient('booking-1')).resolves.toEqual({
      bookingId: 'booking-1', ownerId: 'buyer-1',
      recipientFullName: 'Recipient', recipientEmail: 'recipient@example.test',
    });
  });
});

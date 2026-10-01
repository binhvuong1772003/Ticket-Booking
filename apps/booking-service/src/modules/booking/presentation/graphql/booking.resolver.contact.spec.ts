import { describe, expect, it } from 'vitest';
import { BookingResolver } from './booking.resolver';

const booking = {
  id: 'booking-1',
  userId: 'buyer-1',
  recipientFullName: 'Recipient',
  recipientEmail: 'recipient@example.test',
} as any;

describe('BookingResolver recipient fields', () => {
  const resolver = new BookingResolver({} as any);

  it('returns recipient details to the buyer', () => {
    const context = { req: { user: { sub: 'buyer-1' } } } as any;
    expect(resolver.recipientFullName(booking, context)).toBe('Recipient');
    expect(resolver.recipientEmail(booking, context)).toBe('recipient@example.test');
  });

  it('returns recipient details to an admin', () => {
    const context = { req: { user: { sub: 'admin-1', role: 'ADMIN' } } } as any;
    expect(resolver.recipientFullName(booking, context)).toBe('Recipient');
    expect(resolver.recipientEmail(booking, context)).toBe('recipient@example.test');
  });

  it('hides recipient details from event organizers and other viewers', () => {
    const context = { req: { user: { sub: 'organizer-1', role: 'ORGANIZER' } } } as any;
    expect(resolver.recipientFullName(booking, context)).toBeNull();
    expect(resolver.recipientEmail(booking, context)).toBeNull();
  });
});

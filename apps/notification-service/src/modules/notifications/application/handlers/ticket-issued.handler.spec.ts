import { describe, expect, it, vi } from 'vitest';
import { TicketIssuedEmailHandler } from './ticket-issued.handler';

const event = (eventId: string) => ({
  eventId,
  eventType: 'ticket.issued' as const,
  occurredAt: '2026-09-28T00:00:00.000Z',
  payload: {
    booking_id: 'booking-1', user_id: 'user-1', event_id: 'event-1', session_id: 'session-1',
    tickets: [
      { ticket_id: 'ticket-b', ordinal: 2, template_version: 1, render_revision: 1 },
      { ticket_id: 'ticket-a', ordinal: 1, template_version: 1, render_revision: 1 },
    ],
  },
});

const setup = () => {
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const deliveries = {
    create: vi.fn().mockResolvedValue({ id: 'delivery-1', status: 'QUEUED' }),
    reserveResend: vi.fn().mockResolvedValue(true),
  };
  const tickets = {
    getOwnedTicket: vi.fn().mockResolvedValue({ ticketId: 'ticket-a', bookingId: 'booking-1', status: 'ISSUED', templateVersion: 1 }),
  };
  const auth = { getUserContact: vi.fn().mockResolvedValue({ email: 'buyer@example.test', fullName: 'Buyer', emailVerified: true }) };
  const bookings = { getRecipient: vi.fn().mockResolvedValue({ bookingId: 'booking-1', ownerId: 'user-1', recipientFullName: 'Recipient', recipientEmail: 'recipient@example.test' }) };
  return { handler: new TicketIssuedEmailHandler(queue as any, deliveries as any, tickets as any, auth as any, bookings as any), queue, deliveries, tickets, auth, bookings };
};

describe('TicketIssuedEmailHandler', () => {
  it('deduplicates by sorted ticket IDs and template version, not Kafka event ID', async () => {
    const ctx = setup();
    await ctx.handler.handleTicketIssued(event('event-1'));
    await ctx.handler.handleTicketIssued(event('event-2'));
    expect(ctx.deliveries.create.mock.calls[0][0].dedupKey).toBe(ctx.deliveries.create.mock.calls[1][0].dedupKey);
    expect(ctx.deliveries.create.mock.calls[0][0].ticketIds).toEqual(['ticket-a', 'ticket-b']);
    expect(ctx.deliveries.create.mock.calls[0][0]).toMatchObject({
      recipientFullName: 'Recipient',
      recipientEmail: 'recipient@example.test',
    });
    expect(ctx.queue.add.mock.calls[0][1]).toEqual({ deliveryId: 'delivery-1' });
    expect(JSON.stringify(ctx.queue.add.mock.calls[0][1])).not.toContain('qr_token');
  });

  it('does not requeue a durable delivery already marked sent', async () => {
    const ctx = setup();
    ctx.deliveries.create.mockResolvedValueOnce({ id: 'delivery-sent', status: 'SENT' });
    await ctx.handler.handleTicketIssued(event('replayed-event'));
    expect(ctx.queue.add).not.toHaveBeenCalled();
  });

  it('keeps a queued ledger record when BullMQ enqueue fails', async () => {
    const ctx = setup();
    ctx.queue.add.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(ctx.handler.handleTicketIssued(event('event-1'))).rejects.toThrow('redis unavailable');
    expect(ctx.deliveries.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to account contact for a legacy booking without recipient fields', async () => {
    const ctx = setup();
    ctx.bookings.getRecipient.mockResolvedValueOnce({
      bookingId: 'booking-1', ownerId: 'user-1', recipientFullName: null, recipientEmail: null,
    });
    await ctx.handler.handleTicketIssued(event('legacy'));
    expect(ctx.auth.getUserContact).toHaveBeenCalledWith('user-1');
    expect(ctx.deliveries.create.mock.calls[0][0]).toMatchObject({
      recipientFullName: 'Buyer',
      recipientEmail: 'buyer@example.test',
    });
  });

  it('rechecks ownership and verified email before queuing resend', async () => {
    const ctx = setup();
    const result = await ctx.handler.queueTicketResend('user-1', 'ticket-a');
    expect(ctx.tickets.getOwnedTicket).toHaveBeenCalledWith('user-1', 'ticket-a');
    expect(ctx.deliveries.reserveResend).toHaveBeenCalledWith('user-1', 'ticket-a');
    expect(result).toMatchObject({ deliveryId: 'delivery-1', status: 'queued' });
    expect(ctx.deliveries.create.mock.calls[0][0]).toMatchObject({ requireVerified: true, ticketIds: ['ticket-a'] });
    expect(ctx.deliveries.create.mock.calls[0][0].recipientEmail).toBe('recipient@example.test');
  });

  it('does not send resend to an unverified or voided ticket', async () => {
    const unverified = setup();
    unverified.auth.getUserContact.mockResolvedValueOnce({ email: 'buyer@example.test', emailVerified: false });
    await expect(unverified.handler.queueTicketResend('user-1', 'ticket-a')).rejects.toThrow('Verify your account email');
    expect(unverified.deliveries.create).not.toHaveBeenCalled();

    const voided = setup();
    voided.tickets.getOwnedTicket.mockResolvedValueOnce({ status: 'VOIDED' });
    await expect(voided.handler.queueTicketResend('user-1', 'ticket-a')).rejects.toThrow('Voided tickets');
    expect(voided.auth.getUserContact).not.toHaveBeenCalled();
  });
});

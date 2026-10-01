import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { EmailProcessor } from './email.processor';
import { EmailTemplate } from './email.template';

const ticketId = '00000000-0000-4000-8000-000000000001';
const makeProcessor = (smtpSend = vi.fn().mockResolvedValue({ messageId: 'smtp-id' }), options: Record<string, unknown> = {}) => {
  const smtp = { sendEmail: smtpSend };
  const template = new EmailTemplate();
  const auth = { getUserContact: vi.fn().mockResolvedValue({ id: 'user-1', email: 'buyer@example.test', fullName: 'Binh', emailVerified: true }) };
  const deliveries = {
    claim: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue({ id: 'delivery-1', ownerId: 'user-1', bookingId: 'booking-1', ticketIds: [ticketId], status: 'SENDING', attempts: 1, requireVerified: false }),
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
    ...options,
  };
  const tickets = {
    getTicket: vi.fn().mockResolvedValue({ ticketId, status: 'ISSUED', ticketTypeName: 'VIP', ticketTypeCode: 'VIP' }),
    render: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
  };
  return { processor: new EmailProcessor(smtp as any, template, auth as any, deliveries as any, tickets as any), smtpSend, auth, deliveries, tickets };
};

const job = (data = { deliveryId: 'delivery-1' }) => ({ name: 'ticket-issued-email', data } as any);

describe('EmailProcessor ticket delivery', () => {
  it('sends CID PNG attachments and records SMTP acceptance without putting QR tokens in the job', async () => {
    const ctx = makeProcessor();
    await ctx.processor.process(job());
    expect(ctx.smtpSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'buyer@example.test',
      subject: 'Your tickets',
      attachments: [expect.objectContaining({ filename: `ticket-${ticketId}.png`, cid: `ticket-${ticketId}` })],
      messageId: '<ticket-delivery-1@ticket-booking>',
    }));
    const mail = ctx.smtpSend.mock.calls[0][0];
    expect(mail.html).not.toContain('signed-token');
    expect(ctx.deliveries.markSent).toHaveBeenCalledWith('delivery-1', '<ticket-delivery-1@ticket-booking>');
    expect(job().data).toEqual({ deliveryId: 'delivery-1' });
  });

  it('uses the full ticket link when the configured MIME size limit is exceeded', async () => {
    const previous = process.env.TICKET_EMAIL_MAX_BYTES;
    process.env.TICKET_EMAIL_MAX_BYTES = '10';
    try {
      const ctx = makeProcessor();
      await ctx.processor.process(job());
      const mail = ctx.smtpSend.mock.calls[0][0];
      expect(mail.attachments).toBeUndefined();
      expect(mail.html).toContain('/tickets');
      expect(mail.text).toContain('/tickets');
    } finally {
      if (previous === undefined) delete process.env.TICKET_EMAIL_MAX_BYTES;
      else process.env.TICKET_EMAIL_MAX_BYTES = previous;
    }
  });

  it('sends to the persisted recipient without replacing it with account email', async () => {
    const ctx = makeProcessor(vi.fn().mockResolvedValue({ messageId: 'smtp-id' }), {
      get: vi.fn().mockResolvedValue({
        id: 'delivery-1', ownerId: 'user-1', bookingId: 'booking-1', ticketIds: [ticketId],
        status: 'SENDING', attempts: 1, requireVerified: false,
        recipientFullName: 'Edited Recipient', recipientEmail: 'edited@example.test',
      }),
    });
    await ctx.processor.process(job());
    expect(ctx.smtpSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'edited@example.test',
    }));
    expect(ctx.smtpSend.mock.calls[0][0].html).toContain('Edited Recipient');
    expect(ctx.auth.getUserContact).not.toHaveBeenCalled();
  });

  it('lets a retryable SMTP failure requeue the durable delivery', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('temporary'), { code: 'ECONNECTION' }));
    const ctx = makeProcessor(send);
    await expect(ctx.processor.process(job())).rejects.toThrow('temporary');
    expect(ctx.deliveries.markFailure).toHaveBeenCalledWith('delivery-1', 'ECONNECTION', false);
  });

  it('marks permanent SMTP failures terminal and rejects them from Bull retries', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('auth failed'), { code: 'EAUTH' }));
    const ctx = makeProcessor(send);
    await expect(ctx.processor.process(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(ctx.deliveries.markFailure).toHaveBeenCalledWith('delivery-1', 'EAUTH', true);
  });

  it('does not send concurrently claimed or already sent deliveries', async () => {
    const ctx = makeProcessor(vi.fn(), { claim: vi.fn().mockResolvedValue(false) });
    await ctx.processor.process(job());
    expect(ctx.smtpSend).not.toHaveBeenCalled();
  });
});

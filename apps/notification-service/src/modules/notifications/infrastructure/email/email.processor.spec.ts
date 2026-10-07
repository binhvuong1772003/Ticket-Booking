import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { EmailProcessor } from './email.processor';
import { EmailTemplate } from './email.template';

const ticketId = '00000000-0000-4000-8000-000000000001';
const makeProcessor = (
  smtpSend = vi.fn().mockResolvedValue({ messageId: 'smtp-id' }),
  options: Record<string, unknown> = {},
) => {
  const smtp = { sendEmail: smtpSend };
  const template = new EmailTemplate();
  const auth = {
    getUserContact: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'buyer@example.test',
      fullName: 'Binh',
      emailVerified: true,
    }),
  };
  const deliveries = {
    claim: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue({
      id: 'delivery-1',
      ownerId: 'user-1',
      bookingId: 'booking-1',
      ticketIds: [ticketId],
      status: 'SENDING',
      attempts: 1,
      requireVerified: false,
    }),
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailure: vi.fn().mockResolvedValue(undefined),
    ...options,
  };
  const tickets = {
    getTicket: vi.fn().mockResolvedValue({
      ticketId,
      status: 'ISSUED',
      ticketTypeName: 'VIP',
      ticketTypeCode: 'VIP',
    }),
    render: vi.fn().mockResolvedValue(Buffer.from('png-bytes')),
  };
  return {
    processor: new EmailProcessor(
      smtp as any,
      template,
      auth as any,
      deliveries as any,
      tickets as any,
    ),
    smtpSend,
    auth,
    deliveries,
    tickets,
  };
};

const job = (data = { deliveryId: 'delivery-1' }) =>
  ({ name: 'ticket-issued-email', data }) as any;

describe('EmailProcessor ticket delivery', () => {
  it('sends CID PNG attachments and records SMTP acceptance without putting QR tokens in the job', async () => {
    const ctx = makeProcessor();
    await ctx.processor.process(job());
    expect(ctx.smtpSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@example.test',
        subject: 'Your tickets',
        attachments: [
          expect.objectContaining({
            filename: `ticket-${ticketId}.png`,
            cid: `ticket-${ticketId}`,
          }),
        ],
        messageId: '<ticket-delivery-1@ticket-booking>',
      }),
    );
    const mail = ctx.smtpSend.mock.calls[0][0];
    expect(mail.html).not.toContain('signed-token');
    expect(ctx.deliveries.markSent).toHaveBeenCalledWith(
      'delivery-1',
      '<ticket-delivery-1@ticket-booking>',
    );
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
    const ctx = makeProcessor(
      vi.fn().mockResolvedValue({ messageId: 'smtp-id' }),
      {
        get: vi.fn().mockResolvedValue({
          id: 'delivery-1',
          ownerId: 'user-1',
          bookingId: 'booking-1',
          ticketIds: [ticketId],
          status: 'SENDING',
          attempts: 1,
          requireVerified: false,
          recipientFullName: 'Edited Recipient',
          recipientEmail: 'edited@example.test',
        }),
      },
    );
    await ctx.processor.process(job());
    expect(ctx.smtpSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'edited@example.test',
      }),
    );
    expect(ctx.smtpSend.mock.calls[0][0].html).toContain('Edited Recipient');
    expect(ctx.auth.getUserContact).not.toHaveBeenCalled();
  });

  it('lets a retryable SMTP failure requeue the durable delivery', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('temporary'), { code: 'ECONNECTION' }),
      );
    const ctx = makeProcessor(send);
    await expect(ctx.processor.process(job())).rejects.toThrow('temporary');
    expect(ctx.deliveries.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'ECONNECTION',
      false,
    );
  });

  it('marks permanent SMTP failures terminal and rejects them from Bull retries', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('auth failed'), { code: 'EAUTH' }),
      );
    const ctx = makeProcessor(send);
    await expect(ctx.processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(ctx.deliveries.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'EAUTH',
      true,
    );
  });

  it('does not send concurrently claimed or already sent deliveries', async () => {
    const ctx = makeProcessor(vi.fn(), {
      claim: vi.fn().mockResolvedValue(false),
    });
    await ctx.processor.process(job());
    expect(ctx.smtpSend).not.toHaveBeenCalled();
  });
});

const notification = (overrides: Record<string, unknown> = {}) => ({
  claim: vi.fn().mockResolvedValue({
    delivery: {
      id: 'delivery-1',
      kind: 'VERIFICATION',
      payload: { to: 'buyer@example.test', verificationToken: 'secret-token' },
      attempts: 1,
      expiresAt: new Date(Date.now() + 60_000),
    },
    leaseId: 'lease-1',
  }),
  markSent: vi.fn().mockResolvedValue(true),
  markFailure: vi.fn().mockResolvedValue(true),
  ...overrides,
});

const notificationProcessor = (
  notificationRepo = notification(),
  send = vi.fn().mockResolvedValue({ messageId: 'smtp-id' }),
  authOverrides = {},
) => {
  const smtp = { sendEmail: send };
  const auth = {
    getUserContact: vi.fn().mockResolvedValue({
      id: 'user-1',
      email: 'buyer@example.test',
      fullName: 'Binh',
    }),
    ...authOverrides,
  };
  const ticketDeliveries = {
    claim: vi.fn(),
    get: vi.fn(),
    markSent: vi.fn(),
    markFailure: vi.fn(),
  };
  const tickets = { getTicket: vi.fn(), render: vi.fn() };
  const processor = new EmailProcessor(
    smtp as any,
    new EmailTemplate(),
    auth as any,
    ticketDeliveries as any,
    tickets as any,
    notificationRepo as any,
  );
  return { processor, notificationRepo, send, auth };
};

describe('EmailProcessor notification delivery', () => {
  it('claims the durable delivery and sends with a stable Message-ID', async () => {
    const ctx = notificationProcessor();
    const data = { deliveryId: 'delivery-1' };
    await ctx.processor.process({ name: 'verification-email', data } as any);
    expect(data).toEqual({ deliveryId: 'delivery-1' });
    expect(ctx.notificationRepo.claim).toHaveBeenCalledWith('delivery-1');
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@example.test',
        messageId: '<notification-email-delivery-1@ticket-booking>',
      }),
    );
    expect(ctx.send.mock.calls[0][0].html).toContain('secret-token');
    expect(ctx.notificationRepo.markSent).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      '<notification-email-delivery-1@ticket-booking>',
    );
  });

  it('does not send when another worker or a replay already owns the delivery', async () => {
    const repo = notification({ claim: vi.fn().mockResolvedValue(null) });
    const ctx = notificationProcessor(repo, vi.fn());
    await ctx.processor.process({
      name: 'verification-email',
      data: { deliveryId: 'delivery-1' },
    } as any);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('sends a fresh verification delivery with its own ID', async () => {
    const repo = notification({
      claim: vi.fn().mockResolvedValueOnce({
        delivery: {
          id: 'delivery-new',
          kind: 'VERIFICATION',
          payload: { to: 'new@example.test', verificationToken: 'fresh' },
          attempts: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
        leaseId: 'lease-new',
      }),
    });
    const ctx = notificationProcessor(repo);
    await ctx.processor.process({
      name: 'verification-email',
      data: { deliveryId: 'delivery-new' },
    } as any);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'new@example.test',
        messageId: '<notification-email-delivery-new@ticket-booking>',
      }),
    );
  });

  it('marks expired verification payloads terminal without sending', async () => {
    const repo = notification({
      claim: vi.fn().mockResolvedValue({
        delivery: {
          id: 'delivery-1',
          kind: 'VERIFICATION',
          payload: { to: 'x@example.test', verificationToken: 'old' },
          attempts: 1,
          expiresAt: new Date(0),
        },
        leaseId: 'lease-1',
      }),
    });
    const ctx = notificationProcessor(repo, vi.fn());
    await expect(
      ctx.processor.process({
        name: 'verification-email',
        data: { deliveryId: 'delivery-1' },
      } as any),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repo.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      'verification_expired',
      true,
    );
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('requeues transient SMTP failures and makes permanent or exhausted failures terminal', async () => {
    const transient = notificationProcessor(
      notification(),
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('temporary'), { code: 'ECONNECTION' }),
        ),
    );
    await expect(
      transient.processor.process({
        name: 'verification-email',
        data: { deliveryId: 'delivery-1' },
      } as any),
    ).rejects.toThrow('temporary');
    expect(transient.notificationRepo.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      'ECONNECTION',
      false,
    );

    const permanentRepo = notification();
    const permanent = notificationProcessor(
      permanentRepo,
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('bad credentials'), { code: 'EAUTH' }),
        ),
    );
    await expect(
      permanent.processor.process({
        name: 'verification-email',
        data: { deliveryId: 'delivery-1' },
      } as any),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(permanentRepo.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      'EAUTH',
      true,
    );

    const smtp5xxRepo = notification();
    const smtp5xx = notificationProcessor(
      smtp5xxRepo,
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('rejected'), { responseCode: 550 }),
        ),
    );
    await expect(
      smtp5xx.processor.process({
        name: 'verification-email',
        data: { deliveryId: 'delivery-1' },
      } as any),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(smtp5xxRepo.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      'Error',
      true,
    );

    const exhaustedRepo = notification({
      claim: vi.fn().mockResolvedValue({
        delivery: {
          id: 'delivery-1',
          kind: 'REFUND',
          payload: { bookingId: 'b', userId: 'u', amount: 1, currency: 'USD' },
          attempts: 5,
          expiresAt: null,
        },
        leaseId: 'lease-1',
      }),
    });
    const exhausted = notificationProcessor(
      exhaustedRepo,
      vi.fn().mockRejectedValue(new Error('failed')),
    );
    await expect(
      exhausted.processor.process({
        name: 'refund-email',
        data: { deliveryId: 'delivery-1' },
      } as any),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(exhaustedRepo.markFailure).toHaveBeenCalledWith(
      'delivery-1',
      'lease-1',
      'Error',
      true,
    );
  });

  it('sends refund email from the claimed payload and records the same stable Message-ID', async () => {
    const repo = notification({
      claim: vi.fn().mockResolvedValue({
        delivery: {
          id: 'delivery-2',
          kind: 'REFUND',
          payload: {
            bookingId: 'booking-1',
            userId: 'user-1',
            amount: 50,
            currency: 'USD',
          },
          attempts: 1,
          expiresAt: null,
        },
        leaseId: 'lease-2',
      }),
    });
    const ctx = notificationProcessor(repo);
    await ctx.processor.process({
      name: 'refund-email',
      data: { deliveryId: 'delivery-2' },
    } as any);
    expect(ctx.auth.getUserContact).toHaveBeenCalledWith('user-1');
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@example.test',
        messageId: '<notification-email-delivery-2@ticket-booking>',
      }),
    );
    expect(repo.markSent).toHaveBeenCalledWith(
      'delivery-2',
      'lease-2',
      '<notification-email-delivery-2@ticket-booking>',
    );
  });
});

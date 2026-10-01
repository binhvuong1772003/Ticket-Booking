import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { EmailTemplate } from './email.template';
import { SmtpProvider } from './email.provider';
import { AuthClient } from '../auth/auth.client';
import { EmailDeliveryRepository } from './email-delivery.repository';
import { TicketClient } from '../tickets/ticket.client';

type VerificationEmailJob = {
  to: string;
  verificationToken: string;
  eventId: string;
};

type RefundEmailJob = {
  bookingId: string;
  userId: string;
  amount: number | null;
  currency: string | null;
};

type TicketIssuedEmailJob = { deliveryId: string };

@Processor('email')
export class EmailProcessor extends WorkerHost {
  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly emailTemplate: EmailTemplate,
    private readonly authClient: AuthClient,
    private readonly deliveries: EmailDeliveryRepository,
    private readonly ticketClient: TicketClient,
  ) {
    super();
  }
  async process(
    job: Job<VerificationEmailJob | RefundEmailJob | TicketIssuedEmailJob>,
  ) {
    if (job.name === 'verification-email') {
      const data = job.data as VerificationEmailJob;
      const verifyURL = `${process.env.FRONTEND_URL}/email/verify?token=${data.verificationToken}`;
      const html = this.emailTemplate.verification(data.to, verifyURL);
      await this.smtpProvider.sendEmail({ to: data.to, subject: 'Welcome to our platform', html });
      return;
    }

    if (job.name === 'refund-email') {
      const data = job.data as RefundEmailJob;
      const contact = await this.authClient.getUserContact(data.userId);
      const html = this.emailTemplate.refunded(
        contact.fullName ?? contact.email,
        data.bookingId,
        data.amount,
        data.currency,
      );
      await this.smtpProvider.sendEmail({ to: contact.email, subject: 'Your refund has been issued', html });
      return;
    }

    if (job.name === 'ticket-issued-email') {
      return this.sendTicketDelivery(job as Job<TicketIssuedEmailJob>);
    }
  }
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    console.error('Email job failed', { jobId: job?.id, jobName: job?.name, errorCode: (error as Error & { code?: string }).code ?? error.name });
  }

  private async sendTicketDelivery(job: Job<TicketIssuedEmailJob>) {
    const { deliveryId } = job.data;
    if (!(await this.deliveries.claim(deliveryId))) return;
    const delivery = await this.deliveries.get(deliveryId);
    if (!delivery) throw new Error('ticket_delivery_missing');
    try {
      const contact = delivery.requireVerified || !delivery.recipientEmail || !delivery.recipientFullName
        ? await this.authClient.getUserContact(delivery.ownerId)
        : null;
      if (delivery.requireVerified && !contact?.emailVerified) {
        throw new UnrecoverableError('verified_email_required');
      }
      const recipientEmail = delivery.recipientEmail || contact?.email;
      if (!recipientEmail) throw new UnrecoverableError('recipient_email_missing');
      const recipientName = delivery.recipientFullName || contact?.fullName || recipientEmail;
      const ticketIds = Array.isArray(delivery.ticketIds)
        ? delivery.ticketIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (!ticketIds.length) throw new UnrecoverableError('ticket_ids_missing');
      const tickets = await Promise.all(ticketIds.map((id) => this.ticketClient.getTicket(id)));
      const maxBytes = this.maxTicketEmailBytes();
      const images: { ticketId: string; bytes: Buffer }[] = [];
      let mimeBytes = 0;
      if (ticketIds.length <= 12) {
        for (const id of ticketIds) {
          const bytes = await this.ticketClient.render(id);
          images.push({ ticketId: id, bytes });
          mimeBytes += Math.ceil(bytes.byteLength * 4 / 3) + 4096;
          if (mimeBytes > maxBytes) break;
        }
      }
      const attachImages = images.length === ticketIds.length && mimeBytes <= maxBytes;
      const ticketsUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:3000'}/tickets`;
      const html = this.emailTemplate.ticketIssued(
        recipientName,
        delivery.bookingId,
        tickets.map((ticket) => ({
          ticketId: ticket.ticketId,
          ticketTypeName: ticket.ticketTypeName,
          ticketTypeCode: ticket.ticketTypeCode,
        })),
        attachImages,
        ticketsUrl,
      );
      const attachments = attachImages
        ? images.map((image) => ({
            filename: `ticket-${image.ticketId}.png`,
            content: image.bytes,
            contentType: 'image/png',
            cid: `ticket-${image.ticketId}`,
            disposition: 'inline' as const,
          }))
        : undefined;
      const messageId = `<ticket-${delivery.id}@ticket-booking>`;
      await this.smtpProvider.sendEmail({
        to: recipientEmail,
        subject: 'Your tickets',
        html,
        text: this.emailTemplate.ticketIssuedText(delivery.bookingId, ticketsUrl, attachImages),
        attachments,
        messageId,
      });
      await this.deliveries.markSent(delivery.id, messageId);
    } catch (error) {
      const terminal = error instanceof UnrecoverableError || this.permanentSmtpFailure(error) || delivery.attempts >= 5;
      const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'UNKNOWN');
      await this.deliveries.markFailure(delivery.id, String(code), terminal);
      if (error instanceof UnrecoverableError || this.permanentSmtpFailure(error)) {
        throw error instanceof UnrecoverableError ? error : new UnrecoverableError(String(code));
      }
      throw error;
    }
  }

  private maxTicketEmailBytes() {
    const configured = Number(process.env.TICKET_EMAIL_MAX_BYTES ?? 8 * 1024 * 1024);
    return Number.isInteger(configured) && configured > 0 ? configured : 8 * 1024 * 1024;
  }

  private permanentSmtpFailure(error: unknown) {
    const smtp = error as { code?: string; responseCode?: number };
    return ['EAUTH', 'EENVELOPE'].includes(smtp?.code ?? '') ||
      Boolean(smtp?.responseCode && smtp.responseCode >= 500 && smtp.responseCode < 600);
  }
}

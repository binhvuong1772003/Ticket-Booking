import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EmailTemplate } from './email.template';
import { SmtpProvider } from './email.provider';
import { AuthClient } from '../auth/auth.client';

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

@Processor('email')
export class EmailProcessor extends WorkerHost {
  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly emailTemplate: EmailTemplate,
    private readonly authClient: AuthClient,
  ) {
    super();
  }
  async process(job: Job<VerificationEmailJob | RefundEmailJob>) {
    if (job.name === 'verification-email') {
      const data = job.data as VerificationEmailJob;
      const verifyURL = `${process.env.FRONTEND_URL}/email/verify?token=${data.verificationToken}`;
      const html = this.emailTemplate.verification(data.to, verifyURL);
      await this.smtpProvider.sendEmail(
        data.to,
        'Welcome to our platform',
        html,
      );
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
      await this.smtpProvider.sendEmail(
        contact.email,
        'Your refund has been issued',
        html,
      );
      return;
    }
  }
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error) {
    console.error('Email job failed', {
      jobId: job?.id,
      jobName: job?.name,
      error: error.message,
    });
  }
}

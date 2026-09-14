import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EmailTemplate } from './email.template';
import { SmtpProvider } from './email.provider';

type VerificationEmailJob = {
  to: string;
  verificationToken: string;
  eventId: string;
};

@Processor('email')
export class EmailProcessor extends WorkerHost {
  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly emailTemplate: EmailTemplate,
  ) {
    super();
  }
  async process(job: Job<VerificationEmailJob>) {
    if (job.name !== 'verification-email') {
      return;
    }
    const verifyURL = `${process.env.FRONTEND_URL}/email/verify?token=${job.data.verificationToken}`;
    const html = this.emailTemplate.verification(job.data.to, verifyURL);

    await this.smtpProvider.sendEmail(
      job.data.to,
      'Welcome to our platform',
      html,
    );
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

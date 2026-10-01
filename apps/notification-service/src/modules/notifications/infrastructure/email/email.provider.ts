import nodemailer, { Transporter, type SendMailOptions } from 'nodemailer';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SmtpProvider {
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  async sendEmail(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    attachments?: SendMailOptions['attachments'];
    messageId?: string;
  }) {
    const result = await this.transporter.sendMail({
      from: process.env.SMTP_FROM,
      ...input,
    });
    return { messageId: result.messageId };
  }
}

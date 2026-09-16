import nodemailer, { Transporter } from 'nodemailer';
import { Injectable } from '@nestjs/common';

@Injectable()
export class SmtpProvider {
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    });
  }

  async sendEmail(to: string, subject: string, html: string) {
    await this.transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
    });
  }
}

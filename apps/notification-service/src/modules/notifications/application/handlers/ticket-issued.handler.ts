import {
  ConflictException,
  ForbiddenException,
  Injectable,
  HttpException,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import type { TicketIssuedEvent } from '../../../../../../../libs/contracts/src/events/ticket/ticket-issued.event';
import { AuthClient } from '../../infrastructure/auth/auth.client';
import { EmailDeliveryRepository } from '../../infrastructure/email/email-delivery.repository';
import { TicketClient } from '../../infrastructure/tickets/ticket.client';
import { BookingRecipientClient } from '../../infrastructure/booking/booking-recipient.client';

@Injectable()
export class TicketIssuedEmailHandler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TicketIssuedEmailHandler.name);
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    @InjectQueue('email') private readonly emailQueue: Queue,
    private readonly deliveries: EmailDeliveryRepository,
    private readonly tickets: TicketClient,
    private readonly auth: AuthClient,
    private readonly bookings: BookingRecipientClient,
  ) {}

  async onModuleInit() {
    await this.recoverQueue();
    this.recoveryTimer = setInterval(() => void this.recoverQueue(), 15_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  async handleTicketIssued(event: TicketIssuedEvent) {
    const { booking_id, user_id, tickets } = event.payload;
    if (!booking_id || !user_id || !tickets?.length) return;
    const booking = await this.bookings.getRecipient(booking_id);
    if (booking.ownerId !== user_id) throw new Error('ticket booking owner mismatch');
    const account = booking.recipientEmail && booking.recipientFullName
      ? null
      : await this.auth.getUserContact(user_id);
    const recipientEmail = booking.recipientEmail || account?.email;
    if (!recipientEmail) throw new Error('ticket recipient email is missing');
    const recipientFullName =
      booking.recipientFullName || account?.fullName || recipientEmail;
    const ticketIds = [...new Set(tickets.map((ticket) => ticket.ticket_id))].sort();
    const templateVersion = Math.max(...tickets.map((ticket) => ticket.template_version || 1));
    const key = createHash('sha256')
      .update(`${booking_id}:${ticketIds.join(',')}:${templateVersion}`)
      .digest('hex');
    const delivery = await this.deliveries.create({
      dedupKey: `ticket-issued:${key}`,
      bookingId: booking_id,
      ownerId: user_id,
      recipientFullName,
      recipientEmail,
      ticketIds,
      templateVersion,
    });
    if (delivery.status !== 'SENT') await this.enqueue(delivery.id);
  }

  async queueTicketResend(ownerId: string, ticketId: string) {
    let ticket;
    try {
      ticket = await this.tickets.getOwnedTicket(ownerId, ticketId);
    } catch (error) {
      if ((error as { code?: number }).code === 5) throw new NotFoundException('Ticket not found');
      throw error;
    }
    if (ticket.status === 'VOIDED') throw new ConflictException('Voided tickets cannot be resent');
    const contact = await this.auth.getUserContact(ownerId);
    if (!contact.emailVerified) throw new ForbiddenException('Verify your account email before resending tickets');
    const booking = await this.bookings.getRecipient(ticket.bookingId);
    if (booking.ownerId !== ownerId) throw new NotFoundException('Ticket not found');
    const recipientEmail = booking.recipientEmail || contact.email;
    const recipientFullName = booking.recipientFullName || contact.fullName || recipientEmail;
    if (!(await this.deliveries.reserveResend(ownerId, ticketId))) {
      throw new HttpException('Wait 60 seconds before resending this ticket', 429);
    }

    const delivery = await this.deliveries.create({
      dedupKey: `ticket-resend:${randomUUID()}`,
      bookingId: ticket.bookingId,
      ownerId,
      recipientFullName,
      recipientEmail,
      ticketIds: [ticketId],
      templateVersion: ticket.templateVersion,
      requireVerified: true,
    });
    try {
      await this.enqueue(delivery.id);
    } catch (error) {
      this.logger.warn(`resend delivery ${delivery.id} remains queued: ${this.errorCode(error)}`);
    }
    return { deliveryId: delivery.id, status: 'queued' as const };
  }

  async enqueue(id: string) {
    await this.emailQueue.add('ticket-issued-email', { deliveryId: id }, {
      jobId: `ticket-delivery-${id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  private async recoverQueue() {
    try {
      const queued = await this.deliveries.recoverable();
      for (const delivery of queued) await this.enqueue(delivery.id);
    } catch (error) {
      this.logger.error(`ticket delivery queue recovery failed: ${this.errorCode(error)}`);
    }
  }

  private errorCode(error: unknown) {
    return String((error as { code?: string })?.code ?? (error as Error)?.name ?? 'UNKNOWN');
  }
}

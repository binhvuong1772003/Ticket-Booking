import { Injectable } from '@nestjs/common';

@Injectable()
export class EmailTemplate {
  private escape(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]!);
  }

  verification(name: string, verifyURL: string): string {
    const safeURL = this.escape(verifyURL);
    return `
    <h2>Hello ${this.escape(name)} - Email Verification</h2>
    <p>Click the link below to verify your email:</p>
    <a href="${safeURL}">${safeURL}</a>
  `;
  }

  bookingConfirmed(customerName: string, bookingId: string): string {
    return `
      <h1>Booking confirmed</h1>

      <p>Hello ${this.escape(customerName)}</p>

      <p>
        Your booking ${this.escape(bookingId)} has been confirmed.
      </p>
    `;
  }

  refunded(
    customerName: string,
    bookingId: string,
    amount?: number | null,
    currency?: string | null,
  ): string {
    const amountText =
      amount != null && currency ? `${amount} ${currency.toUpperCase()}` : '';
    return `
      <h1>Refund issued</h1>

      <p>Hello ${this.escape(customerName)}</p>

      <p>
        Your booking ${this.escape(bookingId)} has been refunded${amountText ? ` — ${this.escape(amountText)}` : ''}.
        The amount will return to your original payment method.
      </p>
    `;
  }

  ticketIssued(
    customerName: string,
    bookingId: string,
    tickets: { ticketId: string; ticketTypeName: string; ticketTypeCode: string }[],
    images: boolean,
    ticketsUrl: string,
  ): string {
    const items = tickets
      .map(
        (ticket) => `<tr><td style="padding:12px;border-bottom:1px solid #ddd">
          <b>${this.escape(ticket.ticketTypeName)}</b> (${this.escape(ticket.ticketTypeCode)})<br/>
          <small>${this.escape(ticket.ticketId)}</small>
          ${images ? `<p><img src="cid:ticket-${this.escape(ticket.ticketId)}" alt="Ticket QR" width="360" style="max-width:100%;height:auto" /></p>` : ''}
        </td></tr>`,
      )
      .join('');
    return `
      <div style="font-family:Arial,sans-serif;color:#1b1a17;max-width:720px;margin:auto">
        <h1>Your tickets</h1>
        <p>Hello ${this.escape(customerName)}</p>
        <p>Booking ${this.escape(bookingId)} — ${tickets.length} ticket(s) have been issued.</p>
        <table role="presentation" style="border-collapse:collapse;width:100%">${items}</table>
        ${images ? '<p>Present the QR image at the entrance.</p>' : `<p>Open your account to view and download every ticket: <a href="${this.escape(ticketsUrl)}">My tickets</a></p>`}
      </div>
    `;
  }

  ticketIssuedText(bookingId: string, ticketsUrl: string, images: boolean) {
    return images
      ? `Tickets for booking ${bookingId} are attached. Present a QR image at the entrance.`
      : `Tickets for booking ${bookingId} are ready. View and download all of them: ${ticketsUrl}`;
  }
}

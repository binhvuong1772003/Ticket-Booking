import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type TicketEmailResend = { deliveryId: string; status: 'queued' };

@Injectable()
export class TicketEmailClient {
  async resend(ownerId: string, ticketId: string): Promise<TicketEmailResend> {
    const url = process.env.NOTIFICATION_SERVICE_URL;
    const token = process.env.NOTIFICATION_INTERNAL_SERVICE_TOKEN;
    if (!url || !token) throw new ServiceUnavailableException('Ticket email is unavailable');

    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/$/, '')}/internal/tickets/${encodeURIComponent(ticketId)}/resend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-notification-service-token': token },
        body: JSON.stringify({ ownerId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException('Ticket email is unavailable');
    }

    if (response.status === 403) throw new ForbiddenException('Ticket email resend is forbidden');
    if (response.status === 404) throw new NotFoundException('Ticket not found');
    if (response.status === 409) throw new ConflictException('Ticket email cannot be resent');
    if (response.status === 429) throw new HttpException('Ticket email resend is cooling down', HttpStatus.TOO_MANY_REQUESTS);
    if (!response.ok) throw new ServiceUnavailableException('Ticket email is unavailable');

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ServiceUnavailableException('Ticket email returned an invalid response');
    }
    if (
      !body || typeof body !== 'object' ||
      typeof (body as { deliveryId?: unknown }).deliveryId !== 'string' ||
      !(body as { deliveryId: string }).deliveryId ||
      (body as { status?: unknown }).status !== 'queued'
    ) throw new ServiceUnavailableException('Ticket email returned an invalid response');

    return { deliveryId: (body as { deliveryId: string }).deliveryId, status: 'queued' };
  }
}

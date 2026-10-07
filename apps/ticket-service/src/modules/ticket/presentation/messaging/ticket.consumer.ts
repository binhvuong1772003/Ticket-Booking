import { Controller, Inject, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  KafkaRetriableException,
  Payload,
} from '@nestjs/microservices';
import {
  BookingConfirmedPayload,
  TicketService,
} from '../../application/ticket.service';
import { TicketRepository } from '../../infrastructure/ticket.repository';
import { EventSnapshotClient } from '../../infrastructure/event-snapshot.client';

const TICKET_DEAD_LETTER_TOPIC = 'ticket.dead-letter';
const SECRET_FIELD =
  /authorization|token|secret|password|credential|api[_-]?key/i;
const SECRET_TEXT =
  /(["']?(?:authorization|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^,\s}]+)/gi;

type EventTopic =
  | 'booking.confirmed'
  | 'payment.refunded'
  | 'event.cancelled'
  | 'session.status.changed'
  | 'session.rescheduled';

class InvalidTicketEventError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidTicketEventError(`payload.${field} is required`);
  }
  return value;
}

function requiredInteger(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (!Number.isInteger(value)) {
    throw new InvalidTicketEventError(`payload.${field} must be an integer`);
  }
  return value as number;
}

function optionalString(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new InvalidTicketEventError(`payload.${field} must be a string`);
  }
}

function parseEvent<T>(
  topic: EventTopic,
  value: unknown,
  validatePayload: (payload: Record<string, unknown>) => T,
): T {
  if (!isRecord(value)) {
    throw new InvalidTicketEventError('event must be an object');
  }

  const isEnvelope =
    'payload' in value ||
    'eventId' in value ||
    'eventType' in value ||
    'occurredAt' in value;
  if (
    isEnvelope &&
    (typeof value.eventId !== 'string' ||
      !value.eventId.trim() ||
      value.eventType !== topic ||
      typeof value.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(value.occurredAt)) ||
      !('payload' in value))
  ) {
    throw new InvalidTicketEventError('event envelope is invalid');
  }

  const rawPayload = isEnvelope ? value.payload : value;
  if (!isRecord(rawPayload)) {
    throw new InvalidTicketEventError('event payload must be an object');
  }

  return validatePayload(rawPayload);
}

function redactSecrets(value: unknown, key = ''): unknown {
  if (SECRET_FIELD.test(key)) return '[REDACTED]';
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').replace(SECRET_TEXT, '$1"[REDACTED]"');
  }
  if (typeof value === 'string') {
    return value.replace(SECRET_TEXT, '$1"[REDACTED]"');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactSecrets(child, childKey),
      ]),
    );
  }
  return value;
}

@Controller()
export class TicketConsumer {
  private readonly logger = new Logger(TicketConsumer.name);

  constructor(
    @Inject(TicketService) private readonly ticketService: TicketService,
    private readonly tickets: TicketRepository,
    private readonly eventSnapshots: EventSnapshotClient,
  ) {}

  // Let handler failures reach Kafka so the uncommitted record can be retried;
  // malformed envelopes are dead-lettered and acked instead.
  @EventPattern('booking.confirmed')
  onBookingConfirmed(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'booking.confirmed',
      event,
      context,
      (payload) => ({
        ...(payload as BookingConfirmedPayload),
        booking_id: requiredString(payload, 'booking_id'),
        session_id: requiredString(payload, 'session_id'),
      }),
      (payload) => this.ticketService.issueForBooking(payload),
    );
  }

  @EventPattern('payment.refunded')
  onPaymentRefunded(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'payment.refunded',
      event,
      context,
      (payload) => {
        const booking_id = requiredString(payload, 'booking_id');
        optionalString(payload, 'reason');
        return {
          booking_id,
          reason: payload.reason as string | undefined,
        };
      },
      (payload) =>
        this.tickets.voidTicketsForBooking(
          payload.booking_id,
          payload.reason ?? 'payment refunded',
        ),
    );
  }

  @EventPattern('event.cancelled')
  onEventCancelled(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'event.cancelled',
      event,
      context,
      (payload) => {
        const event_id = requiredString(payload, 'event_id');
        optionalString(payload, 'reason');
        return { event_id, reason: payload.reason as string | undefined };
      },
      (payload) =>
        this.tickets.voidTicketsForEvent(
          payload.event_id,
          payload.reason ?? 'event cancelled',
        ),
    );
  }

  @EventPattern('session.status.changed')
  onSessionStatusChanged(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'session.status.changed',
      event,
      context,
      (payload) => {
        const status = payload.status;
        if (
          status !== undefined &&
          status !== null &&
          typeof status !== 'string'
        ) {
          throw new InvalidTicketEventError('payload.status must be a string');
        }
        const sessionId =
          status === 'CANCELLED'
            ? requiredString(payload, 'sessionId')
            : payload.sessionId;
        return { sessionId, status };
      },
      async (parsed) => {
        if (parsed.status !== 'CANCELLED') return;
        await this.tickets.voidTicketsForSession(
          parsed.sessionId as string,
          'session cancelled',
        );
      },
    );
  }

  @EventPattern('session.rescheduled')
  onSessionRescheduled(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'session.rescheduled',
      event,
      context,
      (payload) => ({
        sessionId: requiredString(payload, 'sessionId'),
        eventId: requiredString(payload, 'eventId'),
        version: requiredInteger(payload, 'version'),
      }),
      async (payload) => {
        const snapshot = await this.eventSnapshots.getTicketSnapshot(
          payload.eventId,
          payload.sessionId,
        );
        if (snapshot.sessionVersion < payload.version) {
          throw new Error('event snapshot is older than reschedule event');
        }
        await this.tickets.updateRescheduledTickets(
          payload.sessionId,
          snapshot,
        );
      },
    );
  }

  private async consume<T>(
    topic: EventTopic,
    value: unknown,
    context: unknown,
    validatePayload: (payload: Record<string, unknown>) => T,
    handle: (payload: T) => Promise<unknown>,
  ) {
    const kafkaContext = context as KafkaContext;
    let payload: T;
    try {
      payload = parseEvent(topic, value, validatePayload);
    } catch (error) {
      if (!(error instanceof InvalidTicketEventError)) throw error;
      await this.deadLetter(topic, value, kafkaContext, error);
      return;
    }

    try {
      await handle(payload);
    } catch (error) {
      this.logFailure(topic, value, kafkaContext, error);
      throw new KafkaRetriableException(`${topic} processing failed`);
    }
  }

  private async deadLetter(
    topic: EventTopic,
    value: unknown,
    context: KafkaContext,
    error: InvalidTicketEventError,
  ) {
    const message = context.getMessage();
    const source = {
      topic: context.getTopic(),
      partition: context.getPartition(),
      offset: message.offset,
    };
    const sourceId = `${source.topic}:${source.partition}:${source.offset}`;
    const eventId =
      isRecord(value) && typeof value.eventId === 'string'
        ? value.eventId
        : null;

    try {
      await context.getProducer().send({
        topic: TICKET_DEAD_LETTER_TOPIC,
        messages: [
          {
            key: sourceId,
            value: JSON.stringify({
              source,
              eventId,
              eventType: topic,
              reason: error.message,
              failedAt: new Date().toISOString(),
              message: redactSecrets(value),
            }),
          },
        ],
      });
    } catch (publishError) {
      this.logFailure(topic, value, context, publishError);
      throw new KafkaRetriableException(`${topic} dead-letter publish failed`);
    }

    this.logFailure(topic, value, context, error);
  }

  private logFailure(
    topic: EventTopic,
    value: unknown,
    context: KafkaContext,
    error: unknown,
  ) {
    const envelope = isRecord(value) ? value : undefined;
    const eventId =
      envelope && typeof envelope.eventId === 'string'
        ? envelope.eventId
        : 'unknown';
    const errorType = error instanceof Error ? error.name : typeof error;
    const message = context.getMessage();

    this.logger.error(
      `${topic} failed source=${context.getTopic()}/${context.getPartition()}/${message.offset} ` +
        `eventId=${eventId} errorType=${errorType}`,
    );
  }
}

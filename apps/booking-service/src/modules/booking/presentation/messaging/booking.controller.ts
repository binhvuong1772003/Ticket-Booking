import { Controller, Inject, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  KafkaRetriableException,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import {
  BookingService,
  EventCancelledPayload,
  PaymentEventPayload,
  RefundRequestPayload,
} from '../../application/booking.service.js';

const BOOKING_DEAD_LETTER_TOPIC = 'booking.dead-letter';
const SECRET_FIELD =
  /authorization|token|secret|password|credential|api[_-]?key/i;
const SECRET_TEXT =
  /(["']?(?:authorization|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^,\s}]+)/gi;

type EventTopic =
  | 'payment.succeeded'
  | 'payment.expired'
  | 'payment.failed'
  | 'payment.refunded'
  | 'event.cancelled'
  | 'booking.refund.requested'
  | 'event.published';

class InvalidBookingEventError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvalidBookingEventError(`payload.${field} is required`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new InvalidBookingEventError(`payload.${field} must be a string`);
  }
}

function parseEvent<T>(
  topic: EventTopic,
  value: unknown,
  validatePayload: (payload: Record<string, unknown>) => T,
): T {
  if (!isRecord(value)) {
    throw new InvalidBookingEventError('event must be an object');
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
    throw new InvalidBookingEventError('event envelope is invalid');
  }

  const rawPayload = isEnvelope ? value.payload : value;
  if (!isRecord(rawPayload)) {
    throw new InvalidBookingEventError('event payload must be an object');
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
export class BookingController {
  private readonly logger = new Logger(BookingController.name);

  constructor(
    @Inject(BookingService) private readonly bookingService: BookingService,
  ) {}

  @MessagePattern('booking.health')
  getHealth() {
    return this.bookingService.getHealth();
  }

  @EventPattern('payment.succeeded')
  onPaymentSucceeded(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'payment.succeeded',
      event,
      context,
      (payload) => {
        const booking_id = requiredString(payload, 'booking_id');
        optionalString(payload, 'payment_intent_id');
        return { ...payload, booking_id } as PaymentEventPayload;
      },
      (payload) => this.bookingService.handlePaymentSucceeded(payload),
    );
  }

  @EventPattern('payment.expired')
  onPaymentExpired(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'payment.expired',
      event,
      context,
      (payload) => {
        const booking_id = requiredString(payload, 'booking_id');
        optionalString(payload, 'payment_intent_id');
        return { ...payload, booking_id } as PaymentEventPayload;
      },
      (payload) => this.bookingService.handlePaymentExpired(payload),
    );
  }

  @EventPattern('payment.failed')
  onPaymentFailed(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'payment.failed',
      event,
      context,
      (payload) => {
        const booking_id = requiredString(payload, 'booking_id');
        optionalString(payload, 'payment_intent_id');
        return { ...payload, booking_id } as PaymentEventPayload;
      },
      (payload) => this.bookingService.handlePaymentFailed(payload),
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
        optionalString(payload, 'payment_intent_id');
        return { ...payload, booking_id } as PaymentEventPayload;
      },
      (payload) => this.bookingService.handlePaymentRefunded(payload),
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
        return { ...payload, event_id } as EventCancelledPayload;
      },
      (payload) => this.bookingService.handleEventCancelled(payload),
    );
  }

  @EventPattern('booking.refund.requested')
  onRefundRequested(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'booking.refund.requested',
      event,
      context,
      (payload) => {
        const booking_id = requiredString(payload, 'booking_id');
        const event_id = requiredString(payload, 'event_id');
        optionalString(payload, 'reason');
        optionalString(payload, 'requested_by');
        return { ...payload, booking_id, event_id } as RefundRequestPayload;
      },
      (payload) => this.bookingService.handleRefundRequest(payload),
    );
  }

  @EventPattern('event.published')
  onEventPublished(@Payload() event: unknown, @Ctx() context: unknown) {
    return this.consume(
      'event.published',
      event,
      context,
      (payload) => ({
        ...payload,
        event_id: requiredString(payload, 'event_id'),
        organizer_id: requiredString(payload, 'organizer_id'),
      }),
      (payload) => this.bookingService.handleEventPublished(payload),
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
      if (!(error instanceof InvalidBookingEventError)) throw error;
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
    error: InvalidBookingEventError,
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
        topic: BOOKING_DEAD_LETTER_TOPIC,
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
    const payload =
      envelope && isRecord(envelope.payload) ? envelope.payload : envelope;
    const eventId =
      envelope && typeof envelope.eventId === 'string'
        ? envelope.eventId
        : 'unknown';
    const bookingId =
      payload && typeof payload.booking_id === 'string'
        ? payload.booking_id
        : 'unknown';
    const errorType = error instanceof Error ? error.name : typeof error;
    const message = context.getMessage();

    this.logger.error(
      `${topic} failed source=${context.getTopic()}/${context.getPartition()}/${message.offset} ` +
        `eventId=${eventId} bookingId=${bookingId} errorType=${errorType}`,
    );
  }
}

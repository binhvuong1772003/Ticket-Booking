import { KafkaContext, KafkaRetriableException } from '@nestjs/microservices';
import { describe, expect, it, vi } from 'vitest';
import { BookingService } from '../../application/booking.service.js';
import { BookingController } from './booking.controller.js';

const occurredAt = '2026-09-29T00:00:00.000Z';

const cases = [
  {
    topic: 'payment.succeeded',
    method: 'handlePaymentSucceeded',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onPaymentSucceeded(event, ctx),
    payload: { booking_id: 'bk-1' },
  },
  {
    topic: 'payment.expired',
    method: 'handlePaymentExpired',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onPaymentExpired(event, ctx),
    payload: { booking_id: 'bk-1' },
  },
  {
    topic: 'payment.failed',
    method: 'handlePaymentFailed',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onPaymentFailed(event, ctx),
    payload: { booking_id: 'bk-1' },
  },
  {
    topic: 'payment.refunded',
    method: 'handlePaymentRefunded',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onPaymentRefunded(event, ctx),
    payload: { booking_id: 'bk-1' },
  },
  {
    topic: 'event.cancelled',
    method: 'handleEventCancelled',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onEventCancelled(event, ctx),
    payload: { event_id: 'evt-1' },
  },
  {
    topic: 'booking.refund.requested',
    method: 'handleRefundRequest',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onRefundRequested(event, ctx),
    payload: { booking_id: 'bk-1', event_id: 'evt-1' },
  },
  {
    topic: 'event.published',
    method: 'handleEventPublished',
    invoke: (
      controller: BookingController,
      event: unknown,
      ctx: KafkaContext,
    ) => controller.onEventPublished(event, ctx),
    payload: { event_id: 'evt-1', organizer_id: 'org-1' },
  },
] as const;

function envelope(topic: string, payload: unknown) {
  return {
    eventId: 'outbox-1',
    eventType: topic,
    occurredAt,
    payload,
  };
}

function kafkaContext(
  topic: string,
  send: (request: unknown) => Promise<unknown>,
) {
  const producer = { send };
  return new KafkaContext([
    {
      offset: '17',
      value: Buffer.from('{}'),
      headers: {},
    },
    2,
    topic,
    {} as never,
    vi.fn(),
    producer as never,
  ] as never);
}

describe('BookingController Kafka events', () => {
  it.each(cases)('$topic retries service failures', async (testCase) => {
    const send = vi.fn(async (_request: unknown) => []);
    const handler = vi
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const controller = new BookingController({
      [testCase.method]: handler,
    } as unknown as BookingService);

    await expect(
      testCase.invoke(
        controller,
        envelope(testCase.topic, testCase.payload),
        kafkaContext(testCase.topic, send),
      ),
    ).rejects.toBeInstanceOf(KafkaRetriableException);

    expect(handler).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the dead-letter broker acknowledgement before completing malformed input', async () => {
    let acknowledge!: (value: unknown) => void;
    const requests: unknown[] = [];
    const send = vi.fn((request: unknown) => {
      requests.push(request);
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    const service = {
      handlePaymentSucceeded: vi.fn(),
    } as unknown as BookingService;
    const controller = new BookingController(service);
    const handling = controller.onPaymentSucceeded(
      envelope('payment.succeeded', {
        booking_id: '',
        access_token: 'must-not-reach-dlq',
      }),
      kafkaContext('payment.succeeded', send),
    );
    let completed = false;
    void handling.then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    acknowledge([]);
    await handling;

    const request = requests[0] as {
      topic: string;
      messages: { key: string; value: string }[];
    };
    const deadLetter = JSON.parse(request.messages[0].value);
    expect(request.topic).toBe('booking.dead-letter');
    expect(request.messages[0].key).toBe('payment.succeeded:2:17');
    expect(deadLetter.source).toEqual({
      topic: 'payment.succeeded',
      partition: 2,
      offset: '17',
    });
    expect(deadLetter.eventId).toBe('outbox-1');
    expect(deadLetter.message.payload.access_token).toBe('[REDACTED]');
    expect(JSON.stringify(deadLetter)).not.toContain('must-not-reach-dlq');
    expect(service.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('retries the source message when publishing its dead letter fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('broker unavailable'));
    const service = {
      handlePaymentSucceeded: vi.fn(),
    } as unknown as BookingService;
    const controller = new BookingController(service);

    await expect(
      controller.onPaymentSucceeded(
        envelope('payment.succeeded', {}),
        kafkaContext('payment.succeeded', send),
      ),
    ).rejects.toBeInstanceOf(KafkaRetriableException);

    expect(service.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('does not dead-letter unknown business errors or missing bookings', async () => {
    const send = vi.fn(async (_request: unknown) => []);
    const error = new Error('booking not found');
    const service = {
      handlePaymentSucceeded: vi.fn().mockRejectedValue(error),
    } as unknown as BookingService;
    const controller = new BookingController(service);

    await expect(
      controller.onPaymentSucceeded(
        envelope('payment.succeeded', { booking_id: 'missing-booking' }),
        kafkaContext('payment.succeeded', send),
      ),
    ).rejects.toBeInstanceOf(KafkaRetriableException);

    expect(send).not.toHaveBeenCalled();
  });

  it('dead-letters an event envelope routed to the wrong topic', async () => {
    const send = vi.fn(async (_request: unknown) => []);
    const service = {
      handlePaymentSucceeded: vi.fn(),
    } as unknown as BookingService;
    const controller = new BookingController(service);

    await controller.onPaymentSucceeded(
      envelope('payment.expired', { booking_id: 'bk-1' }),
      kafkaContext('payment.succeeded', send),
    );

    expect(send).toHaveBeenCalledOnce();
    expect(service.handlePaymentSucceeded).not.toHaveBeenCalled();
  });

  it('accepts a legacy unwrapped event payload', async () => {
    const send = vi.fn(async (_request: unknown) => []);
    const service = {
      handlePaymentSucceeded: vi.fn().mockResolvedValue(undefined),
    } as unknown as BookingService;
    const controller = new BookingController(service);

    await controller.onPaymentSucceeded(
      { booking_id: 'bk-1' },
      kafkaContext('payment.succeeded', send),
    );

    expect(service.handlePaymentSucceeded).toHaveBeenCalledWith({
      booking_id: 'bk-1',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

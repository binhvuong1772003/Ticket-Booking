import { randomBytes } from 'node:crypto';
import { Controller, Module } from '@nestjs/common';
import type { INestMicroservice } from '@nestjs/common/interfaces/nest-microservice.interface';
import { NestFactory } from '@nestjs/core';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { Kafka, type Admin, type Producer } from 'kafkajs';
import { of } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingService } from '../src/modules/booking/application/booking.service.js';
import { BookingRepository } from '../src/modules/booking/infrastructure/booking.repository.js';
import { OutboxProcessor } from '../src/modules/booking/infrastructure/outbox.processor.js';
import { BookingController } from '../src/modules/booking/presentation/messaging/booking.controller.js';

const brokers = process.env.BOOKING_KAFKA_TEST_BROKERS?.split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);
const kafkaDescribe = brokers?.length ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const topic = `booking.integration.${suffix}`;
const groupId = `booking-integration-${suffix}`;

class IsolatedTopicController {
  static bookingController: BookingController;
  static offsets: string[] = [];

  onPaymentSucceeded(event: unknown, context: KafkaContext) {
    IsolatedTopicController.offsets.push(context.getMessage().offset);
    return IsolatedTopicController.bookingController.onPaymentSucceeded(
      event,
      context,
    );
  }
}

Controller()(IsolatedTopicController);
Payload()(IsolatedTopicController.prototype, 'onPaymentSucceeded', 0);
Ctx()(IsolatedTopicController.prototype, 'onPaymentSucceeded', 1);
EventPattern(topic)(
  IsolatedTopicController.prototype,
  'onPaymentSucceeded',
  Object.getOwnPropertyDescriptor(
    IsolatedTopicController.prototype,
    'onPaymentSucceeded',
  )!,
);

class IsolatedKafkaTestModule {}
Module({ controllers: [IsolatedTopicController] })(IsolatedKafkaTestModule);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

kafkaDescribe('Booking Kafka consumer (dedicated broker only)', () => {
  let kafka: Kafka;
  let admin: Admin;
  let producer: Producer;
  let app: INestMicroservice | undefined;

  beforeAll(async () => {
    kafka = new Kafka({
      clientId: `booking-integration-admin-${suffix}`,
      brokers: brokers!,
    });
    admin = kafka.admin();
    producer = kafka.producer();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
    await producer.connect();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (producer) await producer.disconnect();
    if (admin) {
      await admin.deleteTopics({ topics: [topic] });
      await admin.disconnect();
    }
  }, 30_000);

  it('retries the same offset after persistence fails and keeps duplicate outbox effects idempotent', async () => {
    const state = {
      status: 'PENDING',
      paymentStatus: 'PENDING',
      recordCalls: 0,
      confirmationWrites: 0,
      outbox: [] as string[],
    };
    const repository = {
      recordPaymentSucceeded: vi.fn(async () => {
        state.recordCalls += 1;
        if (state.recordCalls === 1)
          throw new Error('simulated database failure');
        if (state.status === 'PENDING' && state.paymentStatus === 'PENDING') {
          state.status = 'CONFIRMING';
          state.paymentStatus = 'PAID';
          return { count: 1 };
        }
        return { count: 0 };
      }),
      findById: vi.fn(async () => ({
        id: 'booking-integration',
        status: state.status,
        paymentStatus: state.paymentStatus,
        inventoryCompensationPending: false,
        items: [{ reservationId: 'reservation-integration' }],
      })),
      claimConfirmation: vi.fn(async () => ({ count: 1 })),
      completeConfirmation: vi.fn(async () => {
        if (state.status !== 'CONFIRMING' || state.paymentStatus !== 'PAID') {
          return { count: 0 };
        }
        state.status = 'CONFIRMED';
        state.confirmationWrites += 1;
        state.outbox.push('booking.confirmed');
        return { count: 1 };
      }),
    };
    const inventoryService = {
      confirm: vi.fn(() => of({ success: true, message: '' })),
    };
    const paymentService = {};
    const grpcClient = {
      getService: vi.fn((name: string) =>
        name === 'InventoryService' ? inventoryService : paymentService,
      ),
    };
    const service = new BookingService(
      grpcClient as never,
      grpcClient as never,
      repository as unknown as BookingRepository,
      { wake: vi.fn() } as unknown as OutboxProcessor,
    );
    service.onModuleInit();
    IsolatedTopicController.bookingController = new BookingController(service);
    IsolatedTopicController.offsets = [];

    const startConsumer = async () => {
      const consumer = await NestFactory.createMicroservice(
        IsolatedKafkaTestModule,
        {
          logger: false,
          transport: Transport.KAFKA,
          options: {
            client: {
              clientId: `booking-integration-consumer-${suffix}`,
              brokers: brokers!,
            },
            consumer: { groupId },
            subscribe: { fromBeginning: true },
          },
        },
      );
      await consumer.listen();
      return consumer;
    };

    app = await startConsumer();
    const event = {
      eventId: `booking-payment-${suffix}`,
      eventType: 'payment.succeeded',
      occurredAt: new Date().toISOString(),
      payload: { booking_id: 'booking-integration' },
    };

    await producer.send({
      topic,
      messages: [{ key: event.eventId, value: JSON.stringify(event) }],
    });
    await waitFor(
      () => state.status === 'CONFIRMED',
      'the failed payment event to be retried and confirmed',
    );
    expect(state.recordCalls).toBe(2);
    expect(state.confirmationWrites).toBe(1);
    expect(state.outbox).toEqual(['booking.confirmed']);
    expect(IsolatedTopicController.offsets).toEqual(['0', '0']);
    expect(state.confirmationWrites).toBe(1);
    expect(state.outbox).toEqual(['booking.confirmed']);
    await waitFor(async () => {
      const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
      return offsets[0]?.partitions[0]?.offset === '1';
    }, 'the isolated consumer group to commit the event');

    await app.close();
    app = await startConsumer();
    await waitFor(async () => {
      const { groups } = await admin.describeGroups([groupId]);
      return groups[0]?.state === 'Stable' && groups[0].members.length > 0;
    }, 'the isolated group to restart');
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(state.recordCalls).toBe(2);
    expect(IsolatedTopicController.offsets).toEqual(['0', '0']);
    expect(state.outbox).toEqual(['booking.confirmed']);
  }, 90_000);
});

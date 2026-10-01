# Booking Kafka consumers

Booking uses NestJS `KafkaRetriableException` to fail the current `eachMessage`
callback when processing has not reached a durable boundary. With the installed
NestJS 12.1.0 and KafkaJS 2.2.4, Nest bubbles that exception to KafkaJS; KafkaJS
does not resolve the offset until the callback succeeds. It retries callback
failures and restarts the consumer after its retry budget is exhausted. A failed
record therefore remains available at the same offset. Offsets for earlier
successful records may still be committed.

## Handler completion and recovery

| Topic                      | A successful handler means                                                                         | Durable recovery                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `payment.succeeded`        | Booking is already `CONFIRMED`, or `CONFIRMING + PAID` was saved                                   | `BookingSweeper` retries Inventory confirmation; the conditional confirmation transaction writes `booking.confirmed` once |
| `payment.expired`          | Booking was expired and holds were released, or the booking already existed in a later state       | `inventoryCompensationPending` is saved before Inventory calls; the sweeper retries unfinished compensation               |
| `payment.failed`           | `paymentFailedAt` was saved, or the existing booking made the event an idempotent no-op            | No external work; a missing booking is retried                                                                            |
| `payment.refunded`         | `REFUNDED` and compensation state were saved, or compensation was already complete                 | `BookingSweeper` retries Inventory release/revoke while compensation remains pending                                      |
| `event.cancelled`          | Active bookings were moved to `CANCELLED` with compensation pending                                | The conditional bulk update is safe to repeat; `BookingSweeper` retries refunds and Inventory work                        |
| `booking.refund.requested` | Refund is unnecessary for the booking state, or cancellation and refund work were durably recorded | Booking sweeper retries refund/Inventory work; payment-service keeps its refund queue                                     |
| `event.published`          | The event-to-organizer catalog projection was upserted                                             | Redelivery repeats the idempotent upsert                                                                                  |

Database errors, missing bookings for booking-specific events, event/booking
mismatches, and other unclassified business failures are retriable. They are not
sent to the dead-letter topic by guessing. A refund request for a booking that
is not paid is a valid no-op. Inventory and payment RPC failures may be
acknowledged only after the relevant booking retry state has been saved.

## Dead letters

Structurally invalid or unsupported Booking events go to `booking.dead-letter`.
Booking awaits KafkaJS producer acknowledgement before returning from the
handler. If publishing fails, the source record fails and Kafka retries it.
Each dead-letter record has a key of `source-topic:partition:offset` and
includes that source tuple, `eventId` when present, expected event type, reason,
failure time, and the received message with common secret fields redacted.
Kafka can redeliver a source record if the process stops after publishing the
dead letter but before committing the source offset; use the source tuple to
identify duplicate dead letters.

Local Kafka creates this topic through `kafka-init` in `compose.yaml`. To inspect
it and the Booking consumer group:

```powershell
docker compose exec -T kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:29092 --topic booking.dead-letter --from-beginning --property print.key=true
docker compose exec -T kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:29092 --describe --group booking-service
```

## Replay and operations

Before replay, fix the malformed source or the business/data issue, verify the
source tuple and event ID, then republish the dead-letter `message` to its
original topic. Preserve the event ID and valid payload; for a legacy unwrapped
message, replay that same unwrapped shape. Booking state changes are conditional
and outbox creation is transactional, so a duplicate valid event is safe to
replay. Do not reset the application consumer group's offsets to replay a
single record.

Monitor `booking-service` group lag and consumer crash/restart logs, as well as
the rate and age of records in `booking.dead-letter`. Missing-booking retries
can keep a partition behind until the projection/data issue is corrected.

This code change does not recover payment messages that were committed before
the fix while Booking had not persisted them. Reconcile those bookings against
payment-service records and perform a controlled, audited replay; no live
records are replayed by this change.

# Durable notification email delivery design

## Goal

Replaying an `auth.user.registered` or `payment.refunded` Kafka event after its BullMQ job completes must not send another email. A lost Redis job after Kafka acknowledgement must still be recoverable. A new verification request with a new event ID remains a new delivery.

## Current behavior

Both handlers enqueue a fixed BullMQ `jobId` and set `removeOnComplete: true`. Once BullMQ removes the completed job, a replay can add it again. The verification and refund branches of `EmailProcessor` send SMTP directly and have no durable sent state. Ticket email already uses a MongoDB delivery ledger, claim lease, and recovery poll; its model has ticket-specific required fields and should remain unchanged.

## Chosen design

Add a separate `NotificationEmailDelivery` collection in notification-service MongoDB with a unique `dedupKey` of `verification:<eventId>` or `refund:<eventId>`. Store an immutable kind and typed payload, status `QUEUED | SENDING | SENT | FAILED`, attempt count, lease ID/deadline, stable Message-ID, sent time, and error code. The verification token must be encrypted with AES-256-GCM using a validated 64-hex-character environment key before MongoDB storage, never logged, and removed from the row when delivery becomes terminal. Keep the small key/status tombstone so later Kafka replay remains a no-op. A verification delivery older than its 24-hour token lifetime must not send a stale link.

Kafka handlers first upsert the delivery intent. `SENT` and terminal `FAILED` are no-ops on replay; otherwise they enqueue a BullMQ job containing only `deliveryId`. A failed enqueue is safe to retry because the intent is already durable. A recovery poll finds queued rows and expired leases and re-enqueues them after Redis loss. The worker atomically claims a row, sends using a stable Message-ID, then marks `SENT` with a lease-ID condition. Transient failures return to `QUEUED` for retry; permanent failures or an exhausted attempt budget become `FAILED`. A new verification request creates a new event ID and therefore a new intent.

BullMQ may remove completed and terminal failed event jobs because MongoDB is the deduplication source. The existing ticket-delivery path stays intact. No change to auth/payment event contracts or GraphQL APIs is required.

## Reliability limit

SMTP acceptance and the MongoDB `SENT` update cannot be atomic. A process crash after SMTP acceptance but before the update can send one duplicate on recovery. A stable Message-ID aids diagnosis but does not guarantee provider deduplication. This design provides at-least-once delivery with durable replay suppression after `SENT`, not absolute exactly-once SMTP delivery.

## Deployment constraint

Notification's active Prisma datasource is MongoDB even though old PostgreSQL migration files and a `migrate deploy` script remain. Generate the Prisma client and create the MongoDB collection/indexes out of band before deploying the new consumer; Docker startup must not mutate schemas. Update the misleading notification migration instructions in the same change. Provision the encryption key before starting notification-service.

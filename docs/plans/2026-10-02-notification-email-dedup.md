# Durable Notification Email Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate verification/refund emails on Kafka replay and recover email work lost from Redis.

**Architecture:** Notification-service persists one MongoDB delivery intent per `kind:eventId`. Kafka handlers enqueue only its ID; the worker claims it conditionally and records SMTP acceptance; a poll recovers queued/expired work. The existing ticket-email ledger remains unchanged.

**Tech Stack:** NestJS, KafkaJS via Nest microservices, BullMQ, Prisma MongoDB, Nodemailer, Node `crypto`, Vitest.

**Spec:** `docs/specs/2026-10-02-notification-email-dedup-design.md`

## Global Constraints

- Do not change auth/payment event contracts or ticket-email behavior.
- `removeOnComplete` and `jobId` are queue hygiene, not the source of durable deduplication.
- No automatic schema change at service startup; notification MongoDB indexes are prepared out of band.
- Do not log, return, or put a raw verification token in a BullMQ job. Keep only an encrypted token in the delivery row until terminal state.
- A new verification request with a new `eventId` must still send, even for the same email address.
- SMTP accepted-before-`SENT` remains an acknowledged at-least-once ambiguity.

## Review Focus

- Duplicate Kafka delivery after BullMQ removed a completed job sends no second email (Task 2 and Task 3 tests).
- Two workers claiming the same delivery at once result in one SMTP call (Task 1 and Task 3 tests).
- Redis enqueue failure or lost job after Kafka ack is recovered from MongoDB (Task 2 and Task 3 tests).
- A terminal SMTP failure does not re-enter the queue on Kafka replay, while a transient failure does retry (Task 3 tests).
- An old verification token is not emailed after its 24-hour lifetime; a fresh resend with a new event ID does send (Task 2 and Task 3 tests).

## File map and agent ownership

| Owner | Files | Deliverable |
| --- | --- | --- |
| Luna A | `apps/notification-service/prisma/schema.prisma`, new `.../infrastructure/email/notification-email-delivery.repository.ts`, new `.../infrastructure/email/notification-email-crypto.ts`, adjacent specs, `.env.example` | Durable intent, encryption, atomic claim/lease, recovery query |
| Luna B | `.../application/handlers/user-registered.handler.ts`, `payment-refunded.handler.ts`, adjacent specs | Persist-then-enqueue, replay decisions |
| Luna C | `.../infrastructure/email/email.processor.ts`, new `.../infrastructure/email/notification-email-recovery.ts`, adjacent specs | Worker send/state transitions and lost-job recovery |
| Sol lead | `.../notifications.module.ts`, deployment docs/package scripts, integration test, final review | Resolve interfaces, wire providers, validate rollout |

Luna B and C may run in parallel **after** Luna A's repository interface is fixed. Only Sol edits module wiring/docs. Use Luna at medium effort; use Sol for the cross-service and security review. Do not run agents in parallel on the same file.

---

### Task 1: Durable notification delivery repository (Luna A)

**Files:**
- Modify: `apps/notification-service/prisma/schema.prisma`
- Create: `apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-delivery.repository.ts`
- Create: `apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-delivery.repository.spec.ts`
- Create: `apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-crypto.ts`
- Create: `apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-crypto.spec.ts`
- Modify: `apps/notification-service/.env.example`

**Interfaces:**
- `createOrGet(input: { kind: 'VERIFICATION' | 'REFUND'; eventId: string; payload: VerificationPayload | RefundPayload; expiresAt?: Date }): Promise<{ id: string; status: string }>`; dedup key is `<kind-lowercase>:<eventId>`, first payload wins.
- `claim(id: string): Promise<{ delivery: NotificationEmailDeliveryWithDecryptedPayload; leaseId: string } | null>` atomically accepts `QUEUED` or expired `SENDING`, increments attempts, and sets a fresh lease ID/deadline. The exported delivery type exposes `id`, `kind`, typed `payload`, `attempts`, and `expiresAt`; decrypt the verification token only after claim.
- `markSent(id: string, leaseId: string, messageId: string): Promise<boolean>` and `markFailure(id: string, leaseId: string, errorCode: string, terminal: boolean): Promise<boolean>` update only the active lease.
- `recoverable(take: number): Promise<Array<{ id: string }>>` resets expired `SENDING` rows to `QUEUED` and lists queued rows in creation order.
- `VerificationPayload = { to: string; verificationToken: string }`; `RefundPayload = { bookingId: string; userId: string; amount: number | null; currency: string | null }`. Encrypt/decrypt only the verification token at the repository boundary with Node AES-256-GCM; require `NOTIFICATION_EMAIL_PAYLOAD_KEY` to be exactly 64 hex characters (32 bytes) at startup, with no fallback key. Store a versioned ciphertext with a random 12-byte IV and 16-byte tag.

- [ ] Write repository/crypto tests: same kind+event ID returns one intent; different kinds or event IDs create separate intents; two conditional claims permit one winner; stale lease cannot mark sent; recovery finds queued and expired leases; stored verification payload/job has no raw token; terminal transition erases encrypted token while retaining the dedup tombstone.
- [ ] Run `bun run test -- apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-delivery.repository.spec.ts apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-crypto.spec.ts`; confirm the new tests fail before implementation.
- [ ] Implement the schema/model and repository to satisfy the tests. Use a unique `dedupKey`, `status`, `attempts`, `leaseId`, `leaseUntil`, `messageId`, `sentAt`, `lastErrorCode`, `expiresAt`, `createdAt`, `updatedAt`, and an index supporting status/lease/creation scans. Do not TTL-delete the dedup tombstone.
- [ ] Run Prisma validate and generate: `bunx prisma validate --schema apps/notification-service/prisma/schema.prisma`; `bun run prisma:generate:notification`. Then rerun the focused tests until green.
- [ ] Commit only Task 1 files with a normal user-authored message and no AI attribution.

### Task 2: Persist before enqueue (Luna B)

**Files:**
- Modify: `apps/notification-service/src/modules/notifications/application/handlers/user-registered.handler.ts`
- Modify: `apps/notification-service/src/modules/notifications/application/handlers/payment-refunded.handler.ts`
- Create: adjacent `*.spec.ts` files for both handlers

**Interfaces:** Use Task 1 `createOrGet`; queue `verification-email` and `refund-email` jobs as `{ deliveryId }` with `jobId: 'notification-email-' + deliveryId`, `attempts: 5`, exponential backoff 5 seconds, `removeOnComplete: true`, `removeOnFail: true`. `SENT`/terminal `FAILED` rows do not enqueue.

- [ ] Write failing handler tests: duplicate event returns existing `SENT` intent without enqueue; `QUEUED` intent enqueues; database failure rejects the Kafka handler; enqueue failure leaves an intent and rejects so Kafka can retry; refund with no `user_id` keeps the current warning/no-email behavior; a fresh verification event ID enqueues a new delivery.
- [ ] Run the two new handler specs and verify the relevant cases fail.
- [ ] Implement input validation and persist-before-enqueue in both handlers. Derive verification expiry from event `occurredAt` plus the current 24-hour auth token lifetime; never put the token in queue data. Preserve the existing event topic names.
- [ ] Run the focused handler specs until green. Commit only Task 2 files.

### Task 3: Worker claim and recovery (Luna C)

**Files:**
- Modify: `apps/notification-service/src/modules/notifications/infrastructure/email/email.processor.ts`
- Modify: `apps/notification-service/src/modules/notifications/infrastructure/email/email.processor.spec.ts`
- Create: `apps/notification-service/src/modules/notifications/infrastructure/email/notification-email-recovery.ts` and adjacent spec

**Interfaces:** The worker receives `{ deliveryId }`, uses Task 1 `claim/markSent/markFailure`, and sends with stable Message-ID `<notification-email-${deliveryId}@ticket-booking>`. Recovery polls every 15 seconds, uses `recoverable(100)`, and enqueues the same stable job ID. A terminal row is not claimable.

- [ ] Write failing tests: after a completed job was removed, replay cannot trigger a second SMTP send; two simultaneous claims yield one send; transient SMTP error requeues; EAUTH/EENVELOPE/SMTP 5xx or exhausted attempts marks `FAILED`; an expired verification token is marked terminal without SMTP; a separate fresh verification event sends; recovery re-enqueues a queued row after Redis loss.
- [ ] Run the worker/recovery specs and verify failure before implementation.
- [ ] Implement the verification/refund branches using the existing templates and auth lookup. Reuse the existing permanent-SMTP-error classifier. Record `SENT` only after SMTP accepts; condition both `SENT` and `FAILED` updates on lease ID. On terminal errors throw `UnrecoverableError` to stop BullMQ retries. Keep ticket branch unchanged.
- [ ] Implement recovery poll with startup sweep and timer cleanup; enqueue failures remain retryable on the next sweep.
- [ ] Run focused specs until green. Commit only Task 3 files.

### Task 4: Integration, rollout, and review (Sol lead)

**Files:**
- Modify: `apps/notification-service/src/modules/notifications/notifications.module.ts`
- Modify: `docs/tickets-and-email.md` and notification migration instructions/scripts that still claim PostgreSQL `migrate deploy`
- Add: one isolated notification integration spec against disposable MongoDB/Redis/SMTP fakes if the repo test harness supports it; otherwise keep the repository/worker tests above and document the remaining integration gap.

- [ ] Wire Task 1 and Task 3 providers once in the module. Review both handlers and worker against the exact repository interface and ensure no raw token appears in queue/logs.
- [ ] Correct the notification deployment instructions: the live schema is MongoDB while `apps/notification-service/prisma/migrations/migration_lock.toml` still says PostgreSQL. After backup and review, apply MongoDB unique/index changes **out of band** with `bunx prisma db push --schema apps/notification-service/prisma/schema.prisma`; do not run the old `prisma migrate deploy` for notification. Provision `NOTIFICATION_EMAIL_PAYLOAD_KEY` before deploying the service.
- [ ] Run targeted specs, `bun run test`, `bun run lint`, `bun run build:notification`, and `docker compose config --quiet`. If local `dist` is locked, use a clean Docker build for the compile check. Do not start a service against real environment data merely to validate the plan.
- [ ] Review the five cases under Review Focus. Verify the observable limit: crash after SMTP accepted and before `SENT` may resend; stable Message-ID is not an exactly-once guarantee.
- [ ] Commit integration/docs, then request a final read-only code review of the combined diff. Push only when explicitly requested for the implementation.

## Deployment order

1. Back up notification MongoDB; set `NOTIFICATION_EMAIL_PAYLOAD_KEY` in the notification runtime.
2. Generate/validate Prisma and run the reviewed `bunx prisma db push --schema apps/notification-service/prisma/schema.prisma` out of band; verify the unique/index definitions exist. Do not use the stale PostgreSQL migration script.
3. Stop new notification traffic and let the old verification/refund queue drain before switching the worker to ID-only jobs; then deploy notification-service and resume traffic. If a no-downtime rollout is required, scope a separate compatibility step to migrate old waiting jobs to delivery rows before switching. Old emails already sent before this rollout have no durable tombstone, so historical replay still needs manual review.
4. Verify one new verification email and one refund email with safe test data; replay each event after completion and verify no second SMTP send. Check queued/failed counts and recovery logs.
5. Keep sent-key tombstones at least as long as any supported Kafka/manual replay window; do not delete them when stripping sensitive payload.

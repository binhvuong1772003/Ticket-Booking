# Tickets and email delivery

Apply the ticket migrations before deploying the changed ticket service:

```sh
bun run prisma:migrate:deploy:ticket
```

Notification uses MongoDB. Its old PostgreSQL migration files and `migrate deploy` command do not apply to the active schema. Back up and review the notification database, provision `NOTIFICATION_EMAIL_PAYLOAD_KEY`, then apply its Prisma schema and indexes **out of band** before deploying notification-service:

```sh
bun run prisma:push:notification
```

Service startup does not apply schema changes. Drain the old verification and refund email jobs before deploying the ID-only worker; previously sent emails have no durable delivery record, so review historical event replays manually.

The ticket migrations are additive: the existing `ticket_snapshots` migration alters the `tickets` table and assumes the ticket schema already exists. A clean database needs that baseline schema provisioned and baselined before `migrate deploy`. The new migration creates the durable booking refund marker. Apply migrations before deploying the new ticket-service code, and stop old ticket-service instances before starting the new consumers; old instances do not check this marker. The migration does not infer refund state for existing bookings. Reconcile previously refunded bookings from a trusted payment/booking source before replaying confirmations; the snapshot backfill does not create refund markers.

The PostgreSQL race tests run only when `TICKET_TEST_DATABASE_URL` points to a dedicated database with ticket migrations applied. They never fall back to `DATABASE_URL`:

```sh
bunx vitest run apps/ticket-service/test/booking-refund.integration.spec.ts
```

The ticket database remains external. Booking and event snapshots are fetched through authenticated GraphQL; no service reads another service's database. Set matching service tokens in the corresponding service `.env` files. `TICKET_INTERNAL_SERVICE_TOKEN` is shared by ticket-service, gateway, and notification-service. `TICKET_CHECKIN_SERVICE_TOKEN` is shared only by ticket-service and gateway. `EVENT_INTERNAL_SERVICE_TOKEN` is shared by event-service and ticket-service. `BOOKING_INTERNAL_SERVICE_TOKEN` is shared by booking-service and ticket-service. `NOTIFICATION_INTERNAL_SERVICE_TOKEN` is shared by notification-service and gateway. Keep `JWT_SECRET` identical across gateway, auth, booking, and event services.

The additive `20261001110000_ticket_poster_image_url` migration adds a nullable ticket poster snapshot. Apply it before deploying the new ticket-service code, after deploying the event-service GraphQL schema with `ticketSnapshot.posterImageUrl`. New tickets store the event poster, and rescheduled tickets refresh that snapshot. Existing complete tickets keep a null poster until they are explicitly refreshed and render with their stored cover or the text-only fallback. New issuance uses ticket template version 2; existing ticket versions and QR credentials are unchanged. The image endpoint remains `private, no-store`.

After migration, backfill old non-void tickets in bounded batches. It does not enqueue email:

```sh
bun run --cwd apps/ticket-service backfill:snapshots
```

The backfill reads the legacy booking item's stored `Float` only when its exact minor-unit field is absent; new bookings use the locked integer minor-unit value. Legacy rows whose booking or event record no longer exists stay incomplete and return `TICKET_PREPARING`.

## HTTP contract

- `GET /tickets?cursor=&limit=20` returns `{ items, nextCursor }`; list items never include QR credentials.
- `GET /tickets/:id` returns the owner's ticket detail and its QR credential, except a void ticket has `qrToken: null`.
- `GET /tickets/:id/image` returns the current PNG with `Cache-Control: private, no-store`.
- `POST /tickets/:id/resend` returns `202 { deliveryId, status: "queued" }`; the request uses the account's verified email and has a 60-second per-ticket cooldown.
- `POST /tickets/check-in` takes `{ sessionId, qrToken, requestId, gateId? }`; scanner identity comes from the authenticated JWT. `requestId` is a UUID retained across retries.

The queue stores only delivery IDs. Email delivery state is in notification MongoDB; SMTP acceptance is recorded as `SENT`, which does not prove inbox delivery. A crash between SMTP acceptance and that database update can resend; retries reuse the same Message-ID. Set `TICKET_EMAIL_MAX_BYTES` to bound attachments; larger batches receive a link to the full ticket list.

Verification delivery expires 24 hours after the auth event timestamp. Auth creates the token before publishing that event, so the token can expire earlier; requesting a new verification email also invalidates the previous token. Exact expiry checks would require auth to publish the token's expiry or expose a validation lookup. A stalled worker may overlap an SMTP send after its lease or BullMQ lock is lost; email delivery remains at least once.

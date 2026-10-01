# Inventory booking relationship validation

`Inventory.sessionId` is the ticket type's authoritative session binding.
`SessionCatalog.eventId` is the session's authoritative event binding. Inventory
reserve compares both bindings with the request in its Mongo transaction before
the conditional stock decrement and hold creation. The reserve response returns
the IDs read from those server records; Booking persists only those returned IDs.

## Existing SessionCatalog records

The new `eventId` field is nullable, so existing MongoDB documents remain valid
and no database migration or `db push` is needed. A missing binding makes reserve
return `UNAVAILABLE`; it must not be inferred from GraphQL input.

Backfill only from Event-service's authoritative `EventSession` records:

1. Read the `(id, eventId)` pairs from Event-service and transfer that small,
   reviewed export to the Inventory operator. Do not connect Inventory to the
   Event database and do not accept IDs from clients.
2. For each pair, set `session_catalogs.eventId` only when `_id` matches the
   session ID and `eventId` is null or absent. For example, use a conditional
   MongoDB `updateOne` with `_id: sessionId` and
   `$or: [{eventId: null}, {eventId: {$exists: false}}]`, then `$set` only
   `eventId`. Do not update `status` or timestamps as part of this operation.
3. Record unmatched sessions and documents already bound to a different event
   for manual reconciliation. Never overwrite a conflicting binding.
4. Verify the export against Event-service and confirm no eligible catalog row
   remains unmapped before enabling the new Booking flow.

Do not replay historical `session.status.changed` messages as a backfill. An old
status event can move the live inventory state backwards. The consumer's
compare-and-set binding is for live messages; it does not make bulk replay safe.

## Rollout order

1. Deploy an Inventory compatibility release with the nullable schema field
   and consumer support for `payload.eventId`; verify both Event-service status
   producers emit it. Keep booking intake paused during this transition.
2. Backfill and verify legacy catalog mappings using the procedure above.
3. Deploy Inventory with the expanded Reserve request/response contract while
   booking intake remains paused.
4. Deploy Booking with `event_id` requests and required server IDs in responses.
   Keep booking traffic paused until compatible Booking and Inventory instances
   are serving together.
5. Remove every old Booking and Inventory instance before declaring the
   relationship validation active. Old Booking omits `event_id`; old Inventory
   omits the authoritative response IDs. The new services intentionally reject
   those incomplete contracts rather than falling back to client IDs.

If a consumer-only compatibility release is not available, backfill the
nullable MongoDB field from the Event-service export before deploying this
combined Inventory change. Pause booking intake before the Inventory deploy and
keep it paused until the new Booking and Inventory instances are serving and
all old instances have been removed.

The GraphQL input remains unchanged. No database migration, application
`db push`, backfill, or historical event replay is performed by service startup.

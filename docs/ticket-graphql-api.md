# Ticket GraphQL API

The frontend sends authenticated requests to `POST http://localhost:3000/graphql` with `Authorization: Bearer <accessToken>`. Ticket identity comes from the verified token; never send an owner or scanner ID as input. GraphQL errors carry their machine-readable code in `errors[].extensions.code`.

## Queries

```graphql
query MyTickets($first: Int = 20, $after: String) {
  myTickets(first: $first, after: $after) {
    items { ticketId bookingId ordinal status issuedAt eventTitle startsAt endsAt timezone ticketTypeName ticketTypeCode }
    nextCursor
  }
}
```

`first` must be from 1 through 100. Pass `nextCursor` unchanged as `after` to load the next page; omit it for the first page. An empty page returns `items: []` and `nextCursor: null`. List items do not contain QR credentials.

```graphql
query MyTicket($id: ID!) {
  myTicket(id: $id) {
    ticketId bookingId ordinal status issuedAt eventTitle startsAt endsAt timezone ticketTypeName ticketTypeCode
    posterImageUrl coverImageUrl venueName venueAddress unitPrice currency templateVersion renderRevision qrToken
  }
}
```

Detail is limited to the authenticated owner. Nullable legacy event/location/image snapshots can be null; `qrToken` is null for a voided ticket. Treat `unitPrice` as a string to preserve the exact amount.

## Mutations

```graphql
mutation ResendTicketEmail($ticketId: ID!) {
  resendTicketEmail(ticketId: $ticketId) { deliveryId status }
}
```

An accepted resend returns `{ deliveryId, status: "queued" }`. Queued means accepted for processing, not delivered. Resend requires the account's verified email, rejects voided tickets, and has a 60-second per-ticket cooldown.

```graphql
mutation CheckInTicket($input: TicketCheckInInput!) {
  checkInTicket(input: $input) { result ticketId }
}
```

`TicketCheckInInput` is `{ sessionId: ID!, qrToken: String!, requestId: ID!, gateId: String }`. Use a new UUID `requestId` for each physical scan. Reuse that same ID if retrying the same scan after a network failure. Results include `ACCEPTED`, `ALREADY_CHECKED_IN`, `VOIDED`, `WRONG_SESSION`, `INVALID_QR`, and `FORBIDDEN`; these are payload results, not GraphQL errors.

## Errors

Handle `errors[].extensions.code`: `UNAUTHENTICATED` for missing/invalid authentication, `BAD_USER_INPUT` for invalid arguments/cursors, `NOT_FOUND` for missing or foreign tickets, `FORBIDDEN` for a resend the account cannot make, `CONFLICT` for voided resend or request-ID conflict, `TOO_MANY_REQUESTS` for resend cooldown, `TICKET_PREPARING` for incomplete legacy snapshots, `SERVICE_UNAVAILABLE` when ticket or notification dependencies are unavailable, and `INTERNAL_SERVER_ERROR` for unexpected failures. Do not infer the error from HTTP status alone.

## PNG download

Keep PNG downloads on the authenticated REST endpoint. It verifies ownership and returns `image/png` with private no-store caching headers:

```ts
const response = await fetch(`http://localhost:3000/tickets/${encodeURIComponent(ticketId)}/image`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (!response.ok) throw new Error('Ticket image download failed');
const imageUrl = URL.createObjectURL(await response.blob());
// Set the image element's src to imageUrl, then URL.revokeObjectURL(imageUrl) when no longer needed.
```

## Frontend migration checklist

- The current `ticket-booking-front-end` checkout has no ticket REST client or My Tickets page yet; use these operations when implementing that screen.
- Use `myTickets` and `myTicket` for ticket list and detail screens.
- Use the mutations above for resend and check-in; parse GraphQL error codes.
- Keep PNG retrieval on authenticated REST using the response Blob.
- Verify list pagination, ownership failures, cooldown errors, scan retries and voided-ticket behavior against controlled accounts.
- Keep the existing REST endpoints available until frontend integration is verified; this document does not claim the frontend has been migrated.

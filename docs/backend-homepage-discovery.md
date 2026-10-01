# Backend homepage discovery API

The examples use event-service GraphQL at `/graphql`. `publicCategories` only returns active categories. The public queries do not include draft events or inactive ticket types.

The generated event-service SDL is in [`event-service.graphql`](./event-service.graphql). It was built from the Nest resolver metadata without starting the service or connecting to a database.

Set the same `BOOKING_INTERNAL_SERVICE_TOKEN` in the booking-service and event-service `.env` files so the private trending query can authenticate.

## Homepage cards

```graphql
query Homepage($first: Int!, $filter: EventsFilterInput) {
  publicCategories {
    id
    name
    slug
  }
  eventsPage(first: $first, filter: $filter) {
    nodes {
      id
      title
      slug
      categoryId
      coverImageUrl
      posterImageUrl
      nextSession {
        id
        name
        startsAt
        city
        venueName
        currency
      }
      priceFrom
      currency
      availability
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  featuredEvents(city: "Hanoi", first: 6) {
    id
    title
    posterImageUrl
    nextSession { startsAt city currency }
    priceFrom
    currency
    availability
  }
  trendingEvents(city: "Hanoi", first: 6) {
    rank
    event {
      id
      title
      posterImageUrl
      nextSession { startsAt city currency }
      priceFrom
      currency
      availability
    }
  }
}
```

`EventsFilterInput` accepts `categoryId` (Mongo ObjectId), `q`, `city`, `startsAtFrom`, `startsAtTo`, and `upcomingOnly`. `first` defaults to 20 and caps at 50. `endCursor` is passed back as `after`. With `upcomingOnly: true`, a matching session must be `SCHEDULED` and have `startsAt > now`; explicit start and end bounds are inclusive.

Featured and trending `first` values range from 1 to 20. `setEventFeatured(eventId, featuredOrder)` requires an admin JWT; use `null` for `featuredOrder` to remove an event from the featured list.

## Ticket availability

```graphql
query EventSessions($eventId: ID!, $first: Int!) {
  eventSessions(eventId: $eventId, first: $first) {
    nodes {
      id
      name
      startsAt
      city
      currency
      ticketTypes {
        id
        name
        price
        quantity
        sold
        salesStartAt
        status
        availableQuantity
        maxPerBooking
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

`price` and `priceFrom` use the session currency's smallest unit. `availableQuantity` is nullable and comes from inventory in one request-scoped batch. It includes active holds and treats expired holds as available even before the sweeper restores the stored counter. A gRPC timeout or missing inventory mapping sets that nullable field to `null` and attaches `INVENTORY_UNAVAILABLE` or `INVENTORY_NOT_READY` to the GraphQL error. The read is advisory; `createBooking` still reserves atomically. `maxPerBooking` is `null` because the current booking contract has no such limit.

`Event.availability` is `AVAILABLE` when an active ticket type has stock, `SOLD_OUT` when sales have opened but no stock remains, `NOT_ON_SALE` before sales open or when no active ticket type exists, `ENDED` after its sessions finish, and `CANCELLED` when the event or all its sessions are cancelled. Availability can be `null` on a non-public event with no session data.

## Trending rules

Trending uses ticket quantities confirmed during the rolling seven days, ordered by quantity descending and event ID ascending. Free confirmed bookings are included. `REFUNDING` bookings remain counted until the full refund changes the booking to `REFUNDED`; refunded rows then leave the aggregate. The current payment contract only supports full-booking refunds, so partial refund quantities cannot be represented yet. Public results are filtered by published status, upcoming scheduled sessions, and optional city before ranks are assigned. Booking dependency failures return a GraphQL error instead of an empty success result. Sales counts are not exposed in the public response.

The booking and event MongoDB schemas declare the required indexes. Apply schema/index changes to the configured external databases through the repository's normal database rollout; this implementation did not connect to or mutate an external database.

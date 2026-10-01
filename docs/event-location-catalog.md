# Event location catalog (v2)

The public event-service GraphQL schema is in [event-service.graphql](./event-service.graphql). `countries` returns VN and US. `places(countryCode: "VN")` returns cities; `places(countryCode: "US")` returns states. Unsupported country codes return `BAD_USER_INPUT`.

| VN city IDs | US state IDs |
| --- | --- |
| `VN-HANOI`, `VN-HOCHIMINH`, `VN-DANANG`, `VN-HAIPHONG` | `US-CA`, `US-TX`, `US-FL`, `US-NY`, `US-IL` |
| `VN-CANTHO`, `VN-HUE`, `VN-NHATRANG`, `VN-DALAT` | `US-WA`, `US-MA`, `US-PA`, `US-GA`, `US-NJ` |
| `VN-OTHER` (Khác) | `US-OTHER` (Khác) |

```graphql
query LocationsAndEvents($country: String!, $place: ID!) {
  countries { code nameVi nameEn }
  places(countryCode: $country) { id type code name countryCode aliases }
  eventsPage(filter: { countryCode: $country, placeId: $place }) {
    nodes { id title nextSession { id placeId city countryCode startsAt } }
    pageInfo { hasNextPage endCursor }
  }
}
```

`EventSession.placeId` is nullable for older records and drafts. Create, update, and reschedule validate its catalog ID against `countryCode`. A named VN city sets `city` to the catalog name. `VN-OTHER` keeps the organizer's city/locality text, which must be nonblank when selected. US states, including `US-OTHER`, leave `city` as the organizer's locality. On a draft, `placeId: null` clears the choice; omitting `placeId` keeps it. A country change on a session with a place requires a new valid place or an explicit clear in the same draft update. A scheduled session cannot clear its place. `eventsPage` and `eventSessions` accept exact `placeId` filtering; both accept `countryCode`. A location-filtered `eventsPage` result has a matching future scheduled session, which is also used for `nextSession`. The legacy `city` filter remains available. Without a location filter, events with older sessions lacking `placeId` remain visible. Event locations are derived from sessions; Event has no separate `placeId`.

## Backfill

Run the script against a **copy** of the target data first. It prints a JSON report and makes no writes by default:

```powershell
bun --env-file=apps/event-service/.env apps/event-service/scripts/backfill-session-place.ts
```

Review `reviewIds` and the public-session counts. Only a unique named VN city alias is eligible for automatic mapping. `VN-OTHER` and `US-OTHER` require an explicit organizer/operator choice; unknown or ambiguous legacy values never become Other automatically. US sessions require manual state assignment; the script never infers a state from `city` or `venueAddress`. To apply after the operator has reviewed the report and made a backup, run the same command with `--apply`. Apply updates only records whose `placeId` is still unset and whose VN country/city values have not changed. Run the report again afterward and compare counts. The script does not push the Prisma schema or create the MongoDB index; prepare the target schema/index separately under the backend deployment process.

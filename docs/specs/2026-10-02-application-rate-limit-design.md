# Application Rate Limit Design

## Goal and boundary

Protect the ticket-booking API from request spam, credential guessing, email abuse, repeated expensive operations, and costly GraphQL documents **without Cloudflare**. This is application-layer protection; it cannot absorb a network-volume DDoS attack. Keep Kafka/gRPC/internal HTTP traffic outside public rate-limit rules, and keep database idempotency/conditional inventory writes as the business safety boundary.

The current public entry point is the NestJS Apollo federated gateway (`/graphql`, `/uploads/*`, `/tickets/*`, and Google OAuth paths). The Compose file binds its port to `127.0.0.1:3000`; production ingress and trusted proxy configuration must be checked separately. Stripe webhooks enter payment-service directly and require a separate policy. Notification already has a durable 60-second per-ticket resend cooldown.

## Chosen approach

Use `rate-limiter-flexible` with the existing `ioredis` stack. Its Redis-backed atomic counters and memory insurance limiter cover multiple gateway instances and temporary Redis outages with less custom concurrency code. Declare dependencies in each workspace that uses them. A shared gateway HTTP middleware applies a coarse IP/user budget before GraphQL/REST work; a gateway Apollo plugin classifies validated GraphQL root fields for action budgets, including per-IP login and resend budgets; auth-service enforces account/email budgets after defensively normalizing the input. The gateway currently forwards only Authorization and Cookie to subgraphs, so auth-service must not claim it knows the real client IP. Auth-service currently has no global `ValidationPipe`, so the limiter must not assume class-validator decorators have already run. Do not use the caller-controlled `operationName` as an action key.

`@nestjs/throttler` plus Redis storage is an alternative for ordinary Nest resolvers, but does not replace a gateway-wide HTTP check for this Apollo Federation gateway. Nginx `limit_req` is another coarse ingress option, but cannot identify the authenticated user or GraphQL action here. No token bucket, sliding log, distributed lock, or waiting-room subsystem is needed in the first release.

## Identity, storage, response

- Authenticated key: verified JWT `sub`. Anonymous key: `req.ip` from the socket/trusted proxy configuration. Never trust arbitrary `X-Forwarded-For`; enable `trust proxy` only for known ingress hops. Hash normalized email and token fingerprints before using them as Redis keys. Never log raw credentials/tokens/email.
- Prefix every short-lived key with `rl:v1:<policy>:` and set an expiry. Use two windows for burst and sustained abuse where indicated below. Different policies have separate keys.
- On a block, REST and the coarse HTTP gate return HTTP 429 with `Retry-After`; GraphQL action blocks return HTTP 429 with a GraphQL `errors` body and `extensions.code = TOO_MANY_REQUESTS`. No downstream mutation may execute after a block.
- On Redis failure, use the library's in-memory insurance limiter with a short command timeout and emit a degraded-mode metric/log. Local fallback is weaker across replicas but keeps sales and gate check-in available. Do not let Redis connection/retry delay an API request indefinitely.
- Start in `observe` mode to measure real traffic, then `enforce` after adjusting thresholds. Local development may use `off`. Production configuration must explicitly select a mode; do not silently default to `off`.

## Initial policy proposals

These are starting values, not measured production capacity. Audit frontend calls and adjust after observing legitimate p95 traffic, 429s, and shared-NAT behavior.

| Case | Key and initial budget | Enforcement point | Notes |
| --- | --- | --- | --- |
| All public gateway traffic | Anonymous IP: 30/10 s and 300/5 min; authenticated user: 60/10 s and 600/5 min | Gateway HTTP before route execution | Include `/graphql`, `/uploads`, `/tickets`, OAuth; exempt health probes. |
| Public event discovery (`eventsPage`, `featuredEvents`, `trendingEvents`) | IP: 30/min for trending; other queries use global budget | Gateway GraphQL action | Page-size validators remain authoritative. |
| Login | IP: 30/5 min; account: 20 failed/hour | Gateway action by IP; auth-service by normalized account | Count failures; reset/decay on successful login. Never reject a correct password solely because other IPs exhausted the account-failure bucket; avoid an attacker locking out the owner. Keep errors generic. |
| Register | IP: 20/hour | Gateway GraphQL action | Keep DB unique constraints; do not use a supplied email as sole key. |
| Resend verification email | IP: 10/hour and normalized email: 3/hour | Gateway action by IP; auth-service by email | Return a generic response for nonexistent email as separate anti-enumeration hardening. |
| Refresh/verify email | IP: 30/min | Gateway GraphQL action | Do not key solely on attacker-supplied token. |
| `createBooking` | Verified user: 6/min and 30/hour | Gateway GraphQL action | Inventory reservation and booking idempotency remain mandatory; no per-event queue yet. |
| Ticket resend | Verified user: 20/hour | Gateway REST + GraphQL action | Preserve notification DB cooldown of 60 seconds per ticket. |
| Ticket image render | Verified user: 30/min | Gateway REST | Avoid CPU-heavy image regeneration floods. |
| Ticket check-in | Verified scanner: 30/10 s and 300/min | Gateway REST + GraphQL action | Do not block normal gate throughput; DB request-id idempotency remains. |
| Image upload | Verified user: 10/10 min | Gateway REST before multipart parsing | Existing 5 MiB/file limit stays; monitor bytes/CPU before adding a separate volume quota. |
| Stripe webhook | No generic user/IP quota | Payment-service signature validation | Preserve Stripe delivery/retry and event idempotency; add body size/concurrency protection only if measured need. |
| Kafka, gRPC, internal GraphQL/HTTP | No public HTTP quota | Network boundary | Restrict ingress; use consumer backpressure/worker concurrency separately. |

## GraphQL resource limits

Before execution, reject excessive document size, depth, aliases, and root fields. Enforce the initial 64 KiB GraphQL JSON body limit in the HTTP body parser and an 8 KiB URL limit for GraphQL GET requests, before GraphQL parsing; enforce depth 10, aliases 20, and root fields 10 on the parsed document. Reject multiple mutation root fields to prevent one HTTP request from carrying many high-risk actions. Count actual AST field names and expanded fragments, not the client-supplied operation name. Audit real frontend operations before enforce mode. Pagination argument caps remain in the owning service. A request cap is not a substitute for query complexity limits.

## Rollout and acceptance

1. Confirm only gateway and the intended Stripe webhook endpoint are externally reachable; internal service ports must not bypass gateway policies.
2. Observe for 24–48 hours, then enforce high-risk auth/email/upload policies; enforce general and booking/check-in limits after checking legitimate traffic. Thresholds and mode are config, not code edits.
3. Count allowed/blocked requests by policy and result, Redis errors, p95 added latency, and false positives. Alert on Redis insurance mode and unusual login/booking spikes. Do not put raw IP/email/token in logs.
4. Integration tests prove cross-instance atomic quota, spoofed forwarded-header resistance, GraphQL alias/batch resistance, one 429 shape per transport, Redis fallback, and no throttling of internal traffic or Stripe webhook retries.

References: [Redis rate limiting](https://redis.io/docs/latest/develop/use-cases/rate-limiter/), [rate-limiter-flexible Redis/insurance strategy](https://github.com/animir/node-rate-limiter-flexible/wiki/Insurance-Strategy), [OWASP GraphQL](https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html), [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

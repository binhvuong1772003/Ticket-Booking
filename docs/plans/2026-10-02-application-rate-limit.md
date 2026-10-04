# Application Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply distributed application-layer rate limits to the public ticket-booking API while preserving booking/check-in availability and existing business invariants.

**Architecture:** Use `rate-limiter-flexible` with `ioredis` for atomic, expiring counters and a local insurance limiter. The gateway first applies a cheap HTTP budget, then Apollo applies GraphQL action and document limits, including per-IP login and email-resend budgets. Auth-service owns account/email budgets after defensively normalizing inputs; it does not currently receive a trusted client IP. Existing notification resend cooldown, booking inventory rules, and Stripe signature/idempotency remain separate.

**Tech Stack:** NestJS 12, Apollo Gateway/Server 5, GraphQL.js, Express, Redis 7.4, ioredis 6, rate-limiter-flexible, Vitest, Bun.

**Spec:** `docs/specs/2026-10-02-application-rate-limit-design.md`

## Global Constraints

- No Cloudflare, DNS, domain, or public deployment work in this plan. Application limiting does not mitigate network-volume DDoS.
- Only the gateway and intended Stripe webhook may be public. Verify deployment ingress before treating gateway limits as complete.
- Do not change Kafka/gRPC contracts, payment/refund state machines, inventory atomic writes, or notification's 60-second per-ticket resend cooldown.
- Never trust client-supplied `operationName`, user ID, email casing, token, or `X-Forwarded-For` as an authoritative identity. Normalize and hash account keys.
- Redis errors must use bounded local insurance; no request may hang on Redis. Prefix/expire rate-limit keys and avoid raw PII in logs.
- Policy mode is `off|observe|enforce`; production must explicitly configure it. Proposed launch quotas are in the spec and must be measured before enforcement.

## Review Focus

- Forged `X-Forwarded-For` from a direct client does not create fresh IP quotas (Task 1 tests).
- Two gateway instances sharing Redis cannot each spend the full same-user quota (Task 1 integration test).
- GraphQL aliases, fragments, multiple mutation roots, and forged operation names cannot bypass action limits (Task 2 tests).
- A blocked GraphQL mutation or REST upload never reaches its downstream handler; response has HTTP 429 and `Retry-After` (Tasks 1–2 tests).
- Redis outage falls back quickly while local insurance still limits abuse; Stripe webhook/internal service calls are unaffected (Tasks 1–4 tests).

## File map

| Area | Files | Responsibility |
| --- | --- | --- |
| Gateway limiter | New `apps/api-gateway/src/common/rate-limit/gateway-rate-limit.service.ts`, `.spec.ts`; `apps/api-gateway/src/app.module.ts` | Singleton Redis/insurance counters, mode, policy names, lifecycle. |
| Coarse HTTP gate | New `apps/api-gateway/src/common/rate-limit/http-rate-limit.middleware.ts`, `.spec.ts`; `apps/api-gateway/src/main.ts` | Per-IP/user budget before GraphQL/REST work; trusted proxy handling; 429 headers. |
| GraphQL gate | New `apps/api-gateway/src/common/rate-limit/graphql-rate-limit.plugin.ts`, `.spec.ts`; new `graphql-operation-limits.ts`, `.spec.ts`; `app.module.ts` | Use resolved AST/root field names; action budgets and document limits before execution. |
| Auth limits | New `apps/auth-service/src/modules/auth/infrastructure/auth-rate-limit.service.ts`, `.spec.ts`; modify `auth.service.ts`, `auth.module.ts`, relevant specs | Failed-login and resend budgets based on defensively normalized account/email; no client-IP assumption or enumeration. |
| Configuration | `apps/api-gateway/package.json`, `apps/auth-service/package.json`, `.env.example` in both services, `compose.yaml`, `bun.lock` | Explicit dependency/env declarations and Redis host/port. |
| Operations | New `docs/rate-limiting.md`; relevant e2e specs | Thresholds, mode rollout, alerting, legitimate traffic checks. |

## Task 1: Gateway distributed HTTP gate

**Interfaces:** `GatewayRateLimitService.consume(policy: string, subject: string, points?: number): Promise<{ allowed: boolean; retryAfterSeconds: number; degraded: boolean }>`; one instance per gateway process, Redis keys shared across instances. `HttpRateLimitMiddleware` consumes it before `/graphql`, `/uploads/*`, `/tickets/*`, and OAuth routes.

- [ ] Write failing tests for anonymous IP and authenticated JWT `sub`, short and long global budgets, route exemptions, 429/`Retry-After`, spoofed forwarded header, Redis error local insurance, and Redis command timeout. Run focused Vitest and confirm expected RED.
- [ ] Add `rate-limiter-flexible` and explicit `ioredis` to gateway workspace; update lockfile. Implement service with Redis-backed atomic counters, per-policy key prefix/TTL, no raw identity in logs, and bounded insurance fallback.
- [ ] Wire middleware after existing JWT decoding but before expensive route work in `main.ts`/`app.module.ts`; configure trusted proxy CIDRs only when known. Keep `X-Forwarded-For` ignored for direct traffic. Return HTTP 429 with `Retry-After` and a stable error code. `observe` mode counts and reports would-block without rejecting; production startup rejects an absent/invalid `RATE_LIMIT_MODE`.
- [ ] Run focused tests, `bun run build:gateway`, lint, Compose config. Add a real-Redis two-process quota test; if local Docker is unavailable, keep the test runnable and report the missing smoke verification.

## Task 2: GraphQL action and resource limits

**Interfaces:** Apollo plugin consumes `GatewayRateLimitService` from Task 1; policy classifier uses parsed operation/root field `name.value`, verified `context.req.user?.sub`, and known action names, never caller `operationName`/alias. HTTP JSON parsing enforces the body cap; GraphQL validation rule(s) reject deep/aliased/multi-root mutation documents before subgraph execution.

- [ ] First add a gateway integration test proving Apollo `didResolveOperation` and `validationRules` execute with `ApolloGatewayDriver`; confirm RED before the plugin. Wire the shared limiter through `GraphQLModule.forRootAsync` so the plugin and HTTP middleware use one provider. If the hook is not wired by this driver version, implement the same policy at its verified pre-execution extension point; do not parse client text a second time in Express middleware.
- [ ] Write failing tests for `login`, `createBooking`, `register`, `refreshAccessToken`, `resendVerificationEmail`, `resendTicketEmail`, `checkInTicket`, and public `trendingEvents`; a client-supplied operation name/alias cannot change the selected bucket. Reject multiple mutation root fields; handle fragments and ordinary multi-root queries according to their actual fields.
- [ ] Implement action budgets from the spec, set a 64 KiB JSON parser body limit and 8 KiB GET URL limit for `/graphql`, and apply GraphQL validation ceilings (depth 10, aliases 20, root fields 10). Audit real frontend operations before enabling these ceilings. Preserve each subgraph's pagination validators.
- [ ] Verify the blocked mutation does not reach the subgraph and produces HTTP 429 plus GraphQL `TOO_MANY_REQUESTS` and `Retry-After`; malformed/oversized documents fail before costly execution. Run gateway tests and build.

## Task 3: Auth account-aware limits

**Interfaces:** `AuthRateLimitService` stores separate normalized-account failure and verification-email counters. The gateway owns per-IP login/resend limits because its federated data source currently forwards Authorization and Cookie, not a trusted client IP. `AuthService.login` defensively validates/normalizes the email for its key, records failed credentials, and clears/decays failure state on successful login. `resendVerificationEmail` consumes a normalized-email quota before publishing mail. Auth-service does not currently install a global `ValidationPipe`.

- [ ] Write failing tests: email case/whitespace share one hashed bucket, failed attempts from multiple IPs share the account-failure budget, a correct password is accepted despite an exhausted account-failure bucket when the caller's own IP limits allow it, and a different account is not blocked by one bad account. Check that no raw email/token appears in Redis keys or logs.
- [ ] Implement the auth-specific Redis limiter using the same library and local insurance policy. Do not permanently lock an account; keep login failures generic. Preserve auth-service's existing JWT/session behavior.
- [ ] Write failing tests for resend abuse and account enumeration, then enforce per-email/IP budgets and return the same public result for nonexistent and already-verified accounts. The email send side effect must not happen after limit rejection.
- [ ] Add auth workspace dependency/env/Compose wiring; run focused auth tests and `bun run build:auth`. Review retry behavior when Redis is down.

## Task 4: REST actions, operations, and rollout

**Interfaces:** Gateway Task 1 middleware selects separate route policies for upload, ticket image, ticket resend, check-in, and OAuth; Task 2 handles the GraphQL equivalents. Notification's DB ticket cooldown still decides whether the same ticket may be resent.

- [ ] Write failing tests for `/uploads/image` quota before multipart parsing, `/tickets/:id/image` render quota, `/tickets/:id/resend` user quota plus existing downstream 60-second cooldown, `/tickets/check-in` scanner throughput, and OAuth routes. Confirm a 429 prevents Cloudinary, ticket rendering, email, or check-in calls.
- [ ] Implement the route-policy table with the spec's initial values. Keep all checks by verified user or socket/trusted IP. Do not add a generic rate limiter to Stripe webhook; keep signature and idempotency tests. Ensure internal service calls are not routed through public policies.
- [ ] Add `docs/rate-limiting.md` with policy table, `off|observe|enforce` configuration, `Retry-After` behavior, Redis degraded mode, and metrics (`allowed`, `would-block`, `blocked`, Redis errors, added p95 latency). No raw PII in metrics labels.
- [ ] Run `bun run test`, `bun run lint`, `bun run build:gateway`, `bun run build:auth`, `docker compose config --quiet`, frozen-lockfile dry run, and scoped Prettier check. Run real Redis smoke when infrastructure is available; record what was actually verified.
- [ ] Roll out in `observe` for 24–48 hours, compare legitimate frontend bursts/shared NAT/scanner throughput, then switch auth/email/upload first and general/booking/check-in second to `enforce`. Tune numbers from metrics; alert on Redis insurance mode and blocks. This operational step requires a real deployment environment.

## Deliberately deferred

- Per-event sale waiting room, distributed semaphores, token bucket, sliding-window log, and per-byte upload quota: add only if measured load or fraud patterns require them.
- CDN/WAF/DDoS protection: excluded by request. App rate limiting cannot prevent bandwidth or connection exhaustion before traffic reaches NestJS.

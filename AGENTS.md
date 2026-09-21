# Local infrastructure

Run from the repository root:

- `docker compose up -d redis kafka kafka-init` starts infrastructure only (the required backend env files must still exist for Compose validation).
- `docker compose config --quiet` validates the Compose configuration.
- `docker compose exec -T redis redis-cli ping` checks Redis (expected: `PONG`).
- `docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --describe --topic 'auth.user.registered|ticket-type.created'` checks the application topics.

Host connections: Redis `localhost:6380`; Kafka `localhost:9092`. This configuration is for local development only.

## Backend services (Docker)

- `bun run start:all` (or `docker compose up -d --build`) builds the shared `ticket-booking-backend:local` image and starts all six services plus infra.
- Each service requires `apps/<service>/.env` (see `.env.example` in each service dir); Compose fails without them. Databases are external only — `DATABASE_URL` must point to a reachable external/host database. Use `host.docker.internal` instead of `localhost` for host-machine databases.
- `JWT_SECRET` must be identical across gateway, auth, booking, and event services.
- No migrations or `prisma db push` run automatically; prepare external schemas out of band.
- Services may process pending outbox/notification work against the supplied external environment on startup.

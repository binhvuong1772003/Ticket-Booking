FROM oven/bun:1.4.2 AS bun
FROM node:22.14.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN node node_modules/prisma/build/index.js generate --schema apps/auth-service/prisma/schema.prisma && node node_modules/prisma/build/index.js generate --schema apps/booking-service/prisma/schema.prisma && node node_modules/prisma/build/index.js generate --schema apps/inventory-service/src/prisma/schema.prisma && node node_modules/prisma/build/index.js generate --schema apps/event-service/prisma/schema.prisma
RUN bun --bun run build
FROM node:22.14.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/libs/contracts/proto ./libs/contracts/proto
USER node
CMD ["node", "dist/apps/api-gateway/main.js"]

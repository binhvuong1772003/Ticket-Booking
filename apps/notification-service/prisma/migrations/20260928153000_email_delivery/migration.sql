CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

CREATE TABLE "email_deliveries" (
  "id" UUID NOT NULL,
  "dedupKey" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "ticketIds" JSONB NOT NULL,
  "templateVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode" TEXT,
  "messageId" TEXT,
  "sentAt" TIMESTAMPTZ(3),
  "leaseUntil" TIMESTAMPTZ(3),
  "requireVerified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_deliveries_dedupKey_key" ON "email_deliveries"("dedupKey");
CREATE UNIQUE INDEX "email_deliveries_messageId_key" ON "email_deliveries"("messageId");
CREATE INDEX "email_deliveries_status_leaseUntil_createdAt_idx" ON "email_deliveries"("status", "leaseUntil", "createdAt");

CREATE TABLE "ticket_email_cooldowns" (
  "ownerId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_email_cooldowns_pkey" PRIMARY KEY ("ownerId", "ticketId")
);
CREATE INDEX "ticket_email_cooldowns_requestedAt_idx" ON "ticket_email_cooldowns"("requestedAt");

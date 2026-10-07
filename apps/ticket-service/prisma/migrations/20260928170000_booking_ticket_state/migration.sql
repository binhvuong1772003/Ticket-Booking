CREATE TABLE IF NOT EXISTS "booking_ticket_states" (
  "bookingId" TEXT NOT NULL,
  "voidedAt" TIMESTAMPTZ(3),
  "voidReason" TEXT,
  CONSTRAINT "booking_ticket_states_pkey" PRIMARY KEY ("bookingId")
);

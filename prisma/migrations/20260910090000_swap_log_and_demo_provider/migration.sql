-- Postgres refuses to use a new enum value in the same transaction that adds it,
-- so the Provider extension is its own migration step ahead of any insert.
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'Demo';

CREATE TYPE "SwapStatus" AS ENUM ('Pending', 'Settled', 'Failed');

CREATE TABLE "Swap" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inputSymbol" TEXT NOT NULL,
    "outputSymbol" TEXT NOT NULL,
    "inAmount" DECIMAL(30,12) NOT NULL,
    "quotedOut" DECIMAL(30,12) NOT NULL,
    "settledOut" DECIMAL(30,12),
    "priceImpactPct" DECIMAL(12,8),
    "slippageBps" INTEGER NOT NULL,
    "routeLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signature" TEXT,
    "status" "SwapStatus" NOT NULL DEFAULT 'Pending',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Swap_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Swap_userId_createdAt_idx" ON "Swap"("userId", "createdAt");

ALTER TABLE "Swap" ADD CONSTRAINT "Swap_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

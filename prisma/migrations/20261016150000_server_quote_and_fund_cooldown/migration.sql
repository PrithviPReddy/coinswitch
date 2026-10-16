-- P1: the server fetches its own quote for every swap and records where it
-- came from; funding gets a per-wallet cooldown.
--
-- Additive and nullable: rows from before the server re-quoted have none of
-- this provenance, and saying so with null is more honest than a default.

ALTER TABLE "Swap"
    ADD COLUMN "inputMint"            TEXT,
    ADD COLUMN "outputMint"           TEXT,
    ADD COLUMN "quotedAt"             TIMESTAMP(3),
    ADD COLUMN "quoteLatencyMs"       INTEGER,
    ADD COLUMN "contextSlot"          INTEGER,
    ADD COLUMN "otherAmountThreshold" TEXT;

ALTER TABLE "SolWallet" ADD COLUMN "lastFundedAt" TIMESTAMP(3);

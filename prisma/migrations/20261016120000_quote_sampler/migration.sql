-- Mainnet quote sampling.
--
-- QuoteSample holds every quote the sampler records, QuoteDrift the same quote
-- asked again after a delay. Both are read-only market observations: nothing
-- here is ever signed, and the sampler only writes rows from real responses.

CREATE TABLE "QuoteSample" (
    "id"                 TEXT NOT NULL,
    "sampledAt"          TIMESTAMP(3) NOT NULL,
    "pair"               TEXT NOT NULL,
    "inputMint"          TEXT NOT NULL,
    "outputMint"         TEXT NOT NULL,
    "inAmountBaseUnits"  TEXT NOT NULL,
    "outAmountBaseUnits" TEXT NOT NULL,
    "effectivePrice"     DECIMAL(38,18) NOT NULL,
    "reportedImpactPct"  DECIMAL(24,12),
    "measuredImpactBps"  DECIMAL(16,6),
    "routeLabels"        TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hopCount"           INTEGER NOT NULL,
    "slippageBps"        INTEGER NOT NULL,
    "contextSlot"        INTEGER,
    "apiLatencyMs"       INTEGER NOT NULL,
    "ladderId"           TEXT NOT NULL,
    "ladderRung"         INTEGER NOT NULL,

    CONSTRAINT "QuoteSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuoteSample_pair_sampledAt_idx" ON "QuoteSample"("pair", "sampledAt");
CREATE INDEX "QuoteSample_ladderId_idx" ON "QuoteSample"("ladderId");

CREATE TABLE "QuoteDrift" (
    "id"                 TEXT NOT NULL,
    "originSampleId"     TEXT NOT NULL,
    "delaySeconds"       INTEGER NOT NULL,
    "requotedAt"         TIMESTAMP(3) NOT NULL,
    "outAmountBaseUnits" TEXT NOT NULL,
    "effectivePrice"     DECIMAL(38,18) NOT NULL,
    "driftBps"           DECIMAL(16,6) NOT NULL,
    "apiLatencyMs"       INTEGER NOT NULL,
    "contextSlot"        INTEGER,

    CONSTRAINT "QuoteDrift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QuoteDrift_originSampleId_idx" ON "QuoteDrift"("originSampleId");
CREATE INDEX "QuoteDrift_requotedAt_idx" ON "QuoteDrift"("requotedAt");

ALTER TABLE "QuoteDrift" ADD CONSTRAINT "QuoteDrift_originSampleId_fkey"
    FOREIGN KEY ("originSampleId") REFERENCES "QuoteSample"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

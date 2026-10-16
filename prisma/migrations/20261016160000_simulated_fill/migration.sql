-- P2: simulated fills, and the audit trail for each one.
--
-- Additive and nullable: rows from before fills were decided carry none of
-- this, and an exact fill has no model, bucket or horizon to record.

ALTER TABLE "Swap"
    ADD COLUMN "fillMode"              TEXT,
    ADD COLUMN "simulatedShortfallBps" DECIMAL(16,6),
    ADD COLUMN "fillModelVersion"      TEXT,
    ADD COLUMN "fillBucketLevel"       TEXT,
    ADD COLUMN "fillBucketKey"         TEXT,
    ADD COLUMN "fillHorizonSeconds"    INTEGER,
    ADD COLUMN "fillLatencyEstimateMs" INTEGER,
    ADD COLUMN "fillVolatility"        DECIMAL(16,6),
    ADD COLUMN "signedAt"              TIMESTAMP(3),
    ADD COLUMN "confirmedAt"           TIMESTAMP(3);

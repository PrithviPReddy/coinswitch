-- Sampler v2.
--
-- Additive and nullable on purpose: the v1 sampler keeps inserting while v2
-- is deployed, and those inserts simply leave these columns empty. Existing
-- rows are filled by scripts/sampler/backfill-v2.mjs from their own stored
-- values; v2 writes all of them on every row.

ALTER TABLE "QuoteSample"
    ADD COLUMN "baselineRouteLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "notionalUsd"         DECIMAL(24,6),
    ADD COLUMN "notionalSource"      TEXT;

ALTER TABLE "QuoteDrift"
    ADD COLUMN "actualElapsedMs" INTEGER;

CREATE INDEX "QuoteSample_notionalSource_idx" ON "QuoteSample"("notionalSource");

-- Multiple devnet wallets per account.
--
-- The one-wallet rule was enforced by a unique index on SolWallet.userId
-- rather than by anything in the application, so lifting it is what actually
-- makes this feature possible. Everything else here is bookkeeping: a label
-- to tell wallets apart, and a wallet reference on Swap so the settlement log
-- can still say which wallet moved.

-- Existing wallets predate labels. Fill them in, then drop the default so the
-- column is required from here on and every new wallet is named deliberately.
ALTER TABLE "SolWallet"
    ADD COLUMN "label"     TEXT NOT NULL DEFAULT 'Wallet 1',
    ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "SolWallet" ALTER COLUMN "label" DROP DEFAULT;

DROP INDEX "SolWallet_userId_key";

CREATE INDEX "SolWallet_userId_createdAt_idx" ON "SolWallet"("userId", "createdAt");

-- Nullable: rows written before this migration were settled when an account
-- had exactly one wallet, so the column is backfilled below rather than
-- guessed at write time.
ALTER TABLE "Swap" ADD COLUMN "walletId" TEXT;

UPDATE "Swap" s
   SET "walletId" = (
       SELECT w."id"
         FROM "SolWallet" w
        WHERE w."userId" = s."userId"
        ORDER BY w."createdAt"
        LIMIT 1
   );

CREATE INDEX "Swap_walletId_createdAt_idx" ON "Swap"("walletId", "createdAt");

ALTER TABLE "Swap" ADD CONSTRAINT "Swap_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "SolWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

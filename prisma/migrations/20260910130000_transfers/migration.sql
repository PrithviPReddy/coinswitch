-- Outbound transfers.
--
-- Deliberately its own table rather than a Swap row with the output columns
-- left empty: Swap exists to hold a quoted figure beside a delivered one, and
-- a send has neither.

CREATE TYPE "TransferStatus" AS ENUM ('Pending', 'Sent', 'Failed');

CREATE TABLE "Transfer" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "walletId"      TEXT NOT NULL,
    "recipient"     TEXT NOT NULL,
    "symbol"        TEXT NOT NULL,
    "amount"        DECIMAL(30,12) NOT NULL,
    "signature"     TEXT,
    "status"        "TransferStatus" NOT NULL DEFAULT 'Pending',
    "failureReason" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transfer_walletId_createdAt_idx" ON "Transfer"("walletId", "createdAt");

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "SolWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

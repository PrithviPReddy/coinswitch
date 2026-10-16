import { getServerSession } from "next-auth";
import db from "@/app/db";
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { authConfig } from "@/app/lib/auth";
import { getSupportedTokens } from "@/app/lib/constants";
import { SettlementUncertainError, fundWallet } from "@/app/lib/devnet";
import { resolveWallet } from "@/app/lib/wallets";
import type { session as AppSession } from "@/app/lib/auth";

/**
 * Tops one wallet up from the vault. Exists so a wallet created seconds
 * before a demo can trade immediately, without a terminal.
 *
 * Which wallet is the caller's choice, so it is named in the body rather than
 * inferred. An account with five wallets has no obvious "the" wallet.
 *
 * Each wallet can be topped up once per cooldown. The vault's SOL only ever
 * drains (see fundWallet), so without this a few clicks could empty it.
 */
export const FUND_COOLDOWN_MINUTES = Number(process.env.FUND_COOLDOWN_MINUTES || 10);
export async function POST(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in first" }, { status: 401 });
  }

  const { walletId } = await readBody(req);

  const solWallet = await resolveWallet(session.user.uid, walletId);

  if (!solWallet) {
    return NextResponse.json(
      { message: "No such wallet on this account" },
      { status: 404 },
    );
  }

  // Claimed with one conditional update, so two quick clicks cannot both get
  // past the check: only one of them matches the "not funded recently" row.
  const now = new Date();
  const cutoff = new Date(now.getTime() - FUND_COOLDOWN_MINUTES * 60_000);
  const claim = await db.solWallet.updateMany({
    where: {
      id: solWallet.id,
      OR: [{ lastFundedAt: null }, { lastFundedAt: { lt: cutoff } }],
    },
    data: { lastFundedAt: now },
  });

  if (claim.count === 0) {
    const last = solWallet.lastFundedAt ?? now;
    const waitMs = last.getTime() + FUND_COOLDOWN_MINUTES * 60_000 - now.getTime();
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return NextResponse.json(
      {
        message: `This wallet was topped up recently. Each wallet can be funded once every ${FUND_COOLDOWN_MINUTES} minutes; try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      { status: 429 },
    );
  }

  try {
    const signatures = await fundWallet(
      new PublicKey(solWallet.publicKey),
      // With mainnet prices attached: top-ups are sized in USD.
      await getSupportedTokens(),
    );

    return NextResponse.json({ signatures });
  } catch (error) {
    // A top-up known not to have applied should not cost the cooldown. One
    // that was broadcast and may still land keeps it, or a retry could fund
    // the wallet twice.
    if (!(error instanceof SettlementUncertainError)) {
      await db.solWallet.update({
        where: { id: solWallet.id },
        data: { lastFundedAt: solWallet.lastFundedAt },
      });
    }

    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Could not fund the wallet",
      },
      { status: 502 },
    );
  }
}

/** The body is optional, so an absent or malformed one is not an error. */
async function readBody(req: NextRequest): Promise<{ walletId?: string }> {
  try {
    return (await req.json()) ?? {};
  } catch {
    return {};
  }
}

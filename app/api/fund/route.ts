import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { authConfig } from "@/app/lib/auth";
import { SUPPORTED_TOKENS } from "@/app/lib/constants";
import { fundWallet } from "@/app/lib/devnet";
import { resolveWallet } from "@/app/lib/wallets";
import type { session as AppSession } from "@/app/lib/auth";

/**
 * Tops one wallet up from the vault. Exists so a wallet created seconds
 * before a demo can trade immediately, without a terminal.
 *
 * Which wallet is the caller's choice, so it is named in the body rather than
 * inferred. An account with five wallets has no obvious "the" wallet.
 */
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

  try {
    const signatures = await fundWallet(
      new PublicKey(solWallet.publicKey),
      SUPPORTED_TOKENS,
    );

    return NextResponse.json({ signatures });
  } catch (error) {
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

import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/app/lib/auth";
import {
  createWalletForUser,
  listWallets,
  toWalletSummary,
  WalletLimitError,
} from "@/app/lib/wallets";
import type { session as AppSession } from "@/app/lib/auth";

/** Every wallet on the account, oldest first, without the private keys. */
export async function GET() {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in first" }, { status: 401 });
  }

  return NextResponse.json({ wallets: await listWallets(session.user.uid) });
}

/**
 * Creates a wallet. There is no request body on purpose: the keypair is
 * generated server side and the label is derived, so there is nothing a
 * caller could usefully send and no way to smuggle in a key from outside.
 */
export async function POST() {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in first" }, { status: 401 });
  }

  try {
    const wallet = await createWalletForUser(session.user.uid);
    return NextResponse.json({ wallet: toWalletSummary(wallet) }, { status: 201 });
  } catch (error) {
    if (error instanceof WalletLimitError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    return NextResponse.json(
      { message: "Could not create the wallet" },
      { status: 500 },
    );
  }
}

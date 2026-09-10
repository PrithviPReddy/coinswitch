import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { authConfig } from "@/app/lib/auth";
import { resolveWallet, toWalletSummary } from "@/app/lib/wallets";
import type { session as AppSession } from "@/app/lib/auth";

const MAX_LABEL_LENGTH = 40;

/** Renames a wallet. The label is cosmetic; nothing on chain changes. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in first" }, { status: 401 });
  }

  const { id } = await params;
  const { label } = (await req.json()) as { label?: string };
  const trimmed = label?.trim() ?? "";

  if (!trimmed) {
    return NextResponse.json(
      { message: "A wallet needs a name" },
      { status: 400 },
    );
  }

  if (trimmed.length > MAX_LABEL_LENGTH) {
    return NextResponse.json(
      { message: `Keep the name under ${MAX_LABEL_LENGTH} characters` },
      { status: 400 },
    );
  }

  // Ownership check: resolveWallet scopes by the session user, so somebody
  // else's wallet id is indistinguishable from one that does not exist.
  const wallet = await resolveWallet(session.user.uid, id);

  if (!wallet) {
    return NextResponse.json(
      { message: "No such wallet on this account" },
      { status: 404 },
    );
  }

  const updated = await db.solWallet.update({
    where: { id: wallet.id },
    data: { label: trimmed },
  });

  return NextResponse.json({ wallet: toWalletSummary(updated) });
}

import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { authConfig } from "@/app/lib/auth";
import { explorerTxUrl } from "@/app/lib/constants";
import type { session as AppSession } from "@/app/lib/auth";

/**
 * Sends made from one wallet, or from the whole account when no wallet is
 * named. userId stays in the where clause either way, so ?walletId= narrows
 * the result but can never widen it past the signed-in user's own transfers.
 */
export async function GET(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ transfers: [] });
  }

  const walletId = new URL(req.url).searchParams.get("walletId");

  const transfers = await db.transfer.findMany({
    where: {
      userId: session.user.uid,
      ...(walletId ? { walletId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  return NextResponse.json({
    transfers: transfers.map((t: (typeof transfers)[number]) => ({
      id: t.id,
      recipient: t.recipient,
      symbol: t.symbol,
      amount: Number(t.amount),
      signature: t.signature,
      explorerUrl: t.signature ? explorerTxUrl(t.signature) : null,
      status: t.status,
      failureReason: t.failureReason,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

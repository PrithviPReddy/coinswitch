import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { authConfig } from "@/app/lib/auth";
import { explorerTxUrl } from "@/app/lib/constants";
import type { session as AppSession } from "@/app/lib/auth";

/**
 * The settlement log for one wallet, or for the whole account when no wallet
 * is named. userId stays in the where clause either way, so ?walletId= narrows
 * the result but can never widen it past the signed-in user's own swaps.
 */
export async function GET(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ swaps: [] });
  }

  const walletId = new URL(req.url).searchParams.get("walletId");

  const swaps = await db.swap.findMany({
    where: {
      userId: session.user.uid,
      ...(walletId ? { walletId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  return NextResponse.json({
    swaps: swaps.map((s: (typeof swaps)[number]) => ({
      id: s.id,
      inputSymbol: s.inputSymbol,
      outputSymbol: s.outputSymbol,
      inAmount: Number(s.inAmount),
      quotedOut: Number(s.quotedOut),
      settledOut: s.settledOut === null ? null : Number(s.settledOut),
      priceImpactPct:
        s.priceImpactPct === null ? null : Number(s.priceImpactPct),
      slippageBps: s.slippageBps,
      routeLabels: s.routeLabels,
      signature: s.signature,
      explorerUrl: s.signature ? explorerTxUrl(s.signature) : null,
      status: s.status,
      failureReason: s.failureReason,
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

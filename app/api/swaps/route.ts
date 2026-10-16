import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { authConfig } from "@/app/lib/auth";
import { devnetConnection, explorerTxUrl } from "@/app/lib/constants";
import { RECONCILE_BATCH, reconcilePending } from "@/app/lib/reconcile";
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

  await reconcileUserPending(session.user.uid);

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
      fillMode: s.fillMode,
      simulatedShortfallBps:
        s.simulatedShortfallBps === null ? null : Number(s.simulatedShortfallBps),
      fillBucketLevel: s.fillBucketLevel,
      fillBucketKey: s.fillBucketKey,
      fillHorizonSeconds: s.fillHorizonSeconds,
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

/**
 * Settles the account's Pending rows that hold a signature, a batch per load,
 * before they are listed. A failure here never blocks the log: the rows just
 * stay Pending until the next load.
 */
async function reconcileUserPending(userId: string) {
  try {
    const pending = await db.swap.findMany({
      where: { userId, status: "Pending", signature: { not: null } },
      orderBy: { createdAt: "asc" },
      take: RECONCILE_BATCH,
      select: {
        id: true,
        signature: true,
        signedAt: true,
        createdAt: true,
        outputMint: true,
        wallet: { select: { publicKey: true } },
      },
    });

    const resolutions = await reconcilePending(
      pending.map((p) => ({
        id: p.id,
        signature: p.signature!,
        signedAt: p.signedAt,
        createdAt: p.createdAt,
        outputMint: p.outputMint,
        walletPublicKey: p.wallet?.publicKey ?? null,
      })),
      devnetConnection,
    );

    for (const r of resolutions) {
      if (r.status === "Settled") {
        await db.swap.update({ where: { id: r.id }, data: { status: "Settled", settledOut: r.settledOut } });
      } else if (r.status === "Failed") {
        await db.swap.update({ where: { id: r.id }, data: { status: "Failed", failureReason: r.failureReason } });
      }
    }
  } catch (error) {
    console.warn("[swaps] reconciliation skipped:", error instanceof Error ? error.message : error);
  }
}

import { authConfig } from "@/app/lib/auth";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { PublicKey } from "@solana/web3.js";
import { resolveWallet } from "@/app/lib/wallets";
import { keypairFromSecret, readBalance, settleSwap } from "@/app/lib/devnet";
import { decideFill } from "@/app/lib/fill";
import { fetchQuote } from "@/app/lib/jupiter";
import { executeSwap, parseSwapRequest, type SwapDeps } from "@/app/lib/swap";
import type { session as AppSession } from "@/app/lib/auth";
import type { Prisma } from "@/app/generated/prisma";

/**
 * Body: { walletId, inputMint, outputMint, inAmountBaseUnits, slippageBps }.
 * Nothing else is read. The server fetches its own quote and settles against
 * that; see app/lib/swap.ts for the sequence and what each status means.
 *
 *   200 Settled   202 Pending (broadcast, outcome unknown)
 *   409 Failed on the slippage bound   502 Failed or no quote
 */
const deps: SwapDeps = {
  fetchQuote,
  decideFill: ({ quote, slippageBps }) =>
    decideFill({ quotedOut: quote.outAmount, slippageBps, mode: "exact" }),
  readBalance,
  settleSwap,
  swaps: {
    create: (data) => db.swap.create({ data: data as Prisma.SwapUncheckedCreateInput }),
    update: (id, data) =>
      db.swap.update({ where: { id }, data: data as Prisma.SwapUncheckedUpdateInput }),
  },
};

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in to swap" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: "Send a JSON body" }, { status: 400 });
  }

  const parsed = parseSwapRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ message: parsed.message }, { status: 400 });
  }

  // Scoped to the session user, so a walletId belonging to somebody else
  // resolves to nothing. The wallet decided here is the one that both signs
  // the transfer out and receives the transfer back.
  const wallet = await resolveWallet(session.user.uid, parsed.request.walletId);

  if (!wallet) {
    return NextResponse.json({ message: "No such wallet on this account" }, { status: 404 });
  }

  const result = await executeSwap(deps, {
    userId: session.user.uid,
    wallet,
    owner: new PublicKey(wallet.publicKey),
    userKeypair: keypairFromSecret(wallet.privateKey),
    request: parsed.request,
  });

  return NextResponse.json(result.body, { status: result.status });
}

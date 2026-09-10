import { authConfig } from "@/app/lib/auth";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import db from "@/app/db";
import { PublicKey } from "@solana/web3.js";
import { resolveWallet } from "@/app/lib/wallets";
import {
  DEFAULT_SLIPPAGE_BPS,
  explorerTxUrl,
  tokenByMint,
} from "@/app/lib/constants";
import {
  fromBaseUnits,
  keypairFromSecret,
  readBalance,
  settleSwap,
} from "@/app/lib/devnet";
import type { session as AppSession } from "@/app/lib/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

type SwapRequest = {
  quoteResponse: any;
  walletId?: string;
};

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in to swap" }, { status: 401 });
  }

  const { quoteResponse, walletId } = (await req.json()) as SwapRequest;

  if (!quoteResponse?.inputMint || !quoteResponse?.outputMint) {
    return NextResponse.json(
      { message: "Quote missing or malformed. Re-run the quote." },
      { status: 400 },
    );
  }

  const inputToken = tokenByMint(quoteResponse.inputMint);
  const outputToken = tokenByMint(quoteResponse.outputMint);

  if (!inputToken || !outputToken) {
    return NextResponse.json(
      { message: "Pair is not in the supported token list" },
      { status: 400 },
    );
  }

  // Scoped to the session user, so a walletId belonging to somebody else
  // resolves to nothing. The wallet decided here is the one that both signs
  // the transfer out and receives the transfer back.
  const solWallet = await resolveWallet(session.user.uid, walletId);

  if (!solWallet) {
    return NextResponse.json(
      { message: "No such wallet on this account" },
      { status: 404 },
    );
  }

  const inBaseUnits = BigInt(quoteResponse.inAmount);
  const outBaseUnits = BigInt(quoteResponse.outAmount);

  const inAmount = fromBaseUnits(inBaseUnits, inputToken.decimals);
  const quotedOut = fromBaseUnits(outBaseUnits, outputToken.decimals);

  const routeLabels: string[] = Array.isArray(quoteResponse.routePlan)
    ? quoteResponse.routePlan
        .map((leg: any) => leg?.swapInfo?.label)
        .filter(Boolean)
    : [];

  // The row is written before the transaction goes out, so a swap that dies
  // mid-flight still leaves evidence rather than vanishing.
  const swap = await db.swap.create({
    data: {
      userId: session.user.uid,
      walletId: solWallet.id,
      inputSymbol: inputToken.name,
      outputSymbol: outputToken.name,
      inAmount,
      quotedOut,
      priceImpactPct: quoteResponse.priceImpactPct
        ? Number(quoteResponse.priceImpactPct)
        : null,
      slippageBps: quoteResponse.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      routeLabels,
    },
  });

  const owner = new PublicKey(solWallet.publicKey);

  try {
    const balanceBefore = await readBalance(outputToken, owner);

    const signature = await settleSwap({
      userKeypair: keypairFromSecret(solWallet.privateKey),
      inputToken,
      outputToken,
      inBaseUnits,
      outBaseUnits,
    });

    // Settled output is read back off devnet rather than copied from the
    // quote, so the two numbers in the receipt come from different sources.
    const balanceAfter = await readBalance(outputToken, owner);
    const settledOut = fromBaseUnits(
      balanceAfter > balanceBefore ? balanceAfter - balanceBefore : BigInt(0),
      outputToken.decimals,
    );

    const updated = await db.swap.update({
      where: { id: swap.id },
      data: { signature, settledOut, status: "Settled" },
    });

    return NextResponse.json({
      id: updated.id,
      signature,
      explorerUrl: explorerTxUrl(signature),
      inAmount,
      quotedOut,
      settledOut,
      inputSymbol: inputToken.name,
      outputSymbol: outputToken.name,
      routeLabels,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Settlement failed on devnet";

    await db.swap.update({
      where: { id: swap.id },
      data: { status: "Failed", failureReason: reason.slice(0, 500) },
    });

    return NextResponse.json({ message: reason }, { status: 502 });
  }
}

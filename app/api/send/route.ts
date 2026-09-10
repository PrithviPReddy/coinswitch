import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import db from "@/app/db";
import { authConfig } from "@/app/lib/auth";
import { explorerTxUrl, tokenByMint } from "@/app/lib/constants";
import {
  fromBaseUnits,
  keypairFromSecret,
  readBalance,
  sendTokens,
  toBaseUnits,
} from "@/app/lib/devnet";
import { resolveWallet } from "@/app/lib/wallets";
import type { session as AppSession } from "@/app/lib/auth";

type SendRequest = {
  walletId?: string;
  mint?: string;
  amount?: number | string;
  recipient?: string;
};

export async function POST(req: NextRequest) {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) {
    return NextResponse.json({ message: "Sign in to send" }, { status: 401 });
  }

  const body = (await req.json()) as SendRequest;

  const token = body.mint ? tokenByMint(body.mint) : undefined;

  if (!token) {
    return NextResponse.json(
      { message: "Pick a supported token" },
      { status: 400 },
    );
  }

  const amount = Number(body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { message: "Enter an amount greater than zero" },
      { status: 400 },
    );
  }

  let recipient: PublicKey;

  try {
    recipient = new PublicKey((body.recipient ?? "").trim());
  } catch {
    return NextResponse.json(
      { message: "That is not a valid Solana address" },
      { status: 400 },
    );
  }

  const wallet = await resolveWallet(session.user.uid, body.walletId);

  if (!wallet) {
    return NextResponse.json(
      { message: "No such wallet on this account" },
      { status: 404 },
    );
  }

  if (recipient.toBase58() === wallet.publicKey) {
    return NextResponse.json(
      { message: "That is the sending wallet's own address" },
      { status: 400 },
    );
  }

  // Checked against devnet rather than the UI's cached balance, which may be
  // a minute old and is trivially edited by the caller either way.
  const baseUnits = toBaseUnits(amount, token.decimals);
  const available = await readBalance(token, new PublicKey(wallet.publicKey));

  if (baseUnits > available) {
    return NextResponse.json(
      {
        message: `That is more ${token.name} than the wallet holds. Available: ${fromBaseUnits(available, token.decimals)}.`,
      },
      { status: 400 },
    );
  }

  // Written before the transaction goes out, the same way a swap is, so a
  // send that dies mid-flight still leaves a record of what was attempted.
  const transfer = await db.transfer.create({
    data: {
      userId: session.user.uid,
      walletId: wallet.id,
      recipient: recipient.toBase58(),
      symbol: token.name,
      amount,
    },
  });

  try {
    const signature = await sendTokens({
      senderKeypair: keypairFromSecret(wallet.privateKey),
      token,
      recipient,
      baseUnits,
    });

    await db.transfer.update({
      where: { id: transfer.id },
      data: { signature, status: "Sent" },
    });

    return NextResponse.json({
      id: transfer.id,
      signature,
      explorerUrl: explorerTxUrl(signature),
      amount,
      symbol: token.name,
      recipient: recipient.toBase58(),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "The transfer failed on devnet";

    await db.transfer.update({
      where: { id: transfer.id },
      data: { status: "Failed", failureReason: reason.slice(0, 500) },
    });

    return NextResponse.json({ message: reason }, { status: 502 });
  }
}

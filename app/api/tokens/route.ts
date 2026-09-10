import { NextRequest, NextResponse } from "next/server";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  devnetConnection,
  getSupportedTokens,
  TokenDetails,
} from "@/app/lib/constants";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

/**
 * Balances are read from devnet, because devnet is where this wallet's tokens
 * live. Prices are mainnet prices, so the USD column reflects what the asset
 * is really worth rather than what a test token is worth (nothing).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const addressParam = searchParams.get("address");

  if (!addressParam) {
    return NextResponse.json(
      { error: "address query param is required" },
      { status: 400 },
    );
  }

  let owner: PublicKey;

  try {
    owner = new PublicKey(addressParam);
  } catch {
    return NextResponse.json(
      { error: "That is not a valid Solana address" },
      { status: 400 },
    );
  }

  const supportedTokens = await getSupportedTokens();

  const balances = await Promise.all(
    supportedTokens.map((token) => getAccountBalance(token, owner)),
  );

  const tokens = supportedTokens.map((token, index) => {
    const balance = balances[index];
    const price = Number(token.price ?? 0);

    return { ...token, balance, usdBalance: balance * price };
  });

  const totalBalance = tokens.reduce((acc, val) => acc + val.usdBalance, 0);

  return NextResponse.json({ tokens, totalBalance });
}

async function getAccountBalance(token: TokenDetails, owner: PublicKey) {
  if (token.native) {
    const balance = await devnetConnection.getBalance(owner);
    return balance / LAMPORTS_PER_SOL;
  }

  if (!token.devnetMint) return 0;

  const ata = getAssociatedTokenAddressSync(
    new PublicKey(token.devnetMint),
    owner,
  );

  try {
    const account = await getAccount(devnetConnection, ata);
    return Number(account.amount) / 10 ** token.decimals;
  } catch {
    // No associated token account yet just means an untouched balance.
    return 0;
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getAccount, getAssociatedTokenAddress, getMint } from "@solana/spl-token"
import { connection, getSupportedTokens } from "@/app/lib/constants";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const addressParam = searchParams.get("address");

  if (!addressParam) {
    return NextResponse.json(
      { error: "address query param is required" },
      { status: 400 }
    );
  }

  let owner: PublicKey;

  try {
    owner = new PublicKey(addressParam);
  } catch {
    return NextResponse.json(
      { error: "Invalid Solana address" },
      { status: 400 }
    );
  }

  const supportedTokens = await getSupportedTokens();

  const balances = await Promise.all(
    supportedTokens.map(token => getAccountBalance(token, owner))
  );

  const tokens = supportedTokens.map((token, index) => {
  const balance = balances[index];
  const price = Number(token.price ?? 0);

  return {
      ...token,
      balance,
      usdBalance: balance * price
    };
  });

  const totalBalance = tokens.reduce(
    (acc, val) => acc + val.usdBalance,
    0
  );

  return NextResponse.json({
    tokens,
    totalBalance
  });

}


async function getAccountBalance(
  token: {
    name: string
    mint: string
    native: boolean
    decimals : number
  },
  owner: PublicKey
) {
  if (token.native) {
    const balance = await connection.getBalance(owner);
    return balance / LAMPORTS_PER_SOL;
  }

  const mint = new PublicKey(token.mint);
  const ata = await getAssociatedTokenAddress(mint, owner);

  const account = await getAccount(connection, ata);

  return Number(account.amount) / 10 ** token.decimals;
}

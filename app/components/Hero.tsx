"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

export default function Hero() {
  const { data: session } = useSession();

  return (
    <main className="mx-auto max-w-6xl px-6 py-20">
      <div className="grid gap-16 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <h1 className="max-w-xl text-[42px] leading-[1.12] text-ink md:text-5xl">
            Swaps priced where the liquidity is, settled where you can check
            them.
          </h1>

          <p className="mt-7 max-w-xl text-[17px] leading-relaxed text-ink-soft">
            CoinSwitch asks Jupiter for a route on Solana mainnet, because that
            is the only network where a quote reflects real depth. The trade
            itself settles on devnet against tokens this project mints, so every
            swap leaves a signature you can open in an explorer and read line by
            line.
          </p>

          <div className="mt-9 flex items-center gap-4">
            <Link
              href={session?.user ? "/dashboard" : "/signin"}
              className="rounded-[6px] bg-emerald px-5 py-2.5 text-sm font-medium text-paper hover:bg-emerald-deep"
            >
              {session?.user ? "Open the terminal" : "Sign in to swap"}
            </Link>
            <a
              href="https://solscan.io/?cluster=devnet"
              target="_blank"
              rel="noreferrer"
              className="text-sm text-ink-soft underline decoration-rule underline-offset-4 hover:text-ink"
            >
              Devnet explorer
            </a>
          </div>
        </div>

        <div className="panel p-7">
          <p className="text-sm text-ink-faint">How one swap travels</p>

          <ol className="mt-6 space-y-0">
            <Step
              network="mainnet"
              title="Route and price"
              body="Jupiter returns the best path across Solana DEXs, its expected output, and the price impact that path carries."
            />
            <Step
              network="local"
              title="Record the quote"
              body="The quoted figure is written to the swap log before anything is signed, so it cannot be revised after the fact."
            />
            <Step
              network="devnet"
              title="Settle atomically"
              body="One transaction moves the input to the vault and the output back. Both legs land or neither does."
            />
            <Step
              network="devnet"
              title="Read it back"
              body="The delivered amount is read from account state after confirmation, then shown beside the quote."
              last
            />
          </ol>
        </div>
      </div>
    </main>
  );
}

function Step({
  network,
  title,
  body,
  last = false,
}: {
  network: string;
  title: string;
  body: string;
  last?: boolean;
}) {
  return (
    <li className={last ? "py-4" : "border-b border-rule py-4"}>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-[15px] text-ink">{title}</h3>
        <span className="figure shrink-0 text-[11px] text-emerald">
          {network}
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{body}</p>
    </li>
  );
}

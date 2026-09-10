"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function AppBar() {
  const { data: session } = useSession();
  const router = useRouter();

  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <button
          onClick={() => router.push(session?.user ? "/dashboard" : "/")}
          className="flex items-baseline gap-2.5"
        >
          <span className="font-serif text-xl text-ink">CoinSwitch</span>
          <span className="figure text-[11px] text-ink-faint">devnet</span>
        </button>

        {session?.user ? (
          <div className="flex items-center gap-5">
            <Link
              href="/dashboard"
              className="text-sm text-ink-soft hover:text-ink"
            >
              Terminal
            </Link>
            <button
              onClick={() => signOut({ callbackUrl: "/" })}
              className="text-sm text-ink-soft hover:text-ink"
            >
              Sign out
            </button>
          </div>
        ) : (
          <Link
            href="/signin"
            className="rounded-[6px] bg-ink px-4 py-2 text-sm text-paper hover:bg-emerald-deep"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

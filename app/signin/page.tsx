"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function SignIn() {
  const [username, setUsername] = useState("demo@coinswitch.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitDemo() {
    setBusy(true);
    setError(null);

    const result = await signIn("demo", {
      username,
      password,
      redirect: false,
    });

    setBusy(false);

    if (result?.error) {
      setError("Those credentials did not match the demo account.");
      return;
    }

    window.location.href = "/dashboard";
  }

  return (
    <main className="mx-auto max-w-md px-6 py-20">
      <h1 className="text-3xl text-ink">Sign in</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        A devnet wallet is created for your account on first sign-in and funded
        from the project vault.
      </p>

      <div className="panel mt-8 p-6">
        <label className="block text-sm text-ink-soft" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="figure mt-2 w-full rounded-[6px] border border-rule px-3 py-2 text-sm outline-none focus:border-emerald"
        />

        <label
          className="mt-5 block text-sm text-ink-soft"
          htmlFor="password"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitDemo()}
          className="figure mt-2 w-full rounded-[6px] border border-rule px-3 py-2 text-sm outline-none focus:border-emerald"
        />

        {error && <p className="mt-4 text-sm text-flag">{error}</p>}

        <button
          onClick={submitDemo}
          disabled={busy}
          className="mt-6 w-full rounded-[6px] bg-ink py-2.5 text-sm text-paper hover:bg-emerald-deep disabled:opacity-50"
        >
          {busy ? "Signing in" : "Sign in"}
        </button>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-rule" />
        <span className="text-xs text-ink-faint">or</span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <button
        onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
        className="mt-6 w-full rounded-[6px] border border-rule bg-paper py-2.5 text-sm text-ink hover:bg-mist"
      >
        Continue with Google
      </button>
    </main>
  );
}

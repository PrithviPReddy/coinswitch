"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export function ProfileCard({ publicKey }: { publicKey: string }) {
  const { data: session } = useSession();
  const [copied,setCopied] = useState(false)

  return (
    <div className="w-full max-w-4xl mx-auto bg-white rounded-2xl shadow-sm p-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        {session?.user?.image && (
          <img
            src={session.user.image}
            alt="Profile"
            className="h-14 w-14 rounded-full border"
          />
        )}

        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Welcome back, {session?.user?.name?.split(" ")[0] || "Trader"}
          </h2>
          <p className="text-sm text-slate-500">
            Your DCEX wallet overview
          </p>
        </div>
      </div>

      {/* Balance */}
      <div className="mt-8 flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">Total Balance</p>
          <p className="text-4xl font-bold text-slate-900">$0.00 USD</p>
        </div>

        <button 
        className="px-4 py-2 rounded-lg bg-black text-sm font-medium text-blue-100 hover:bg-gray-200 transition"
        onClick={async () => {
          navigator.clipboard.writeText(publicKey)
          setCopied(true)
          setTimeout(() => setCopied(false),2000)
        }}>
          Wallet Address
        </button>
      </div>

      {/* Wallet */}
      <div className="mt-4 bg-slate-50 rounded-lg px-4 py-3 flex items-center justify-between text-sm font-mono text-slate-600">
        <span className="truncate">{publicKey}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(publicKey)
            setCopied(true)
            setTimeout(() => setCopied(false),2000)
          }}
          className="ml-4 text-blue-600 hover:underline text-xs"
        >
          Copy
        </button>
      </div>

      {/* Actions */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Action label="Send" primary />
        <Action label="Add Funds" />
        <Action label="Withdraw" />
        <Action label="Swap" />
      </div>

      {/* Assets */}
      <div className="mt-10 border-t pt-6 text-center text-slate-500">
        <p className="text-lg font-medium">
          You don’t have any assets yet
        </p>
        <p className="text-sm mt-1">
          Start by adding funds or buying crypto
        </p>
        <button className="mt-5 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition">
          Add Funds
        </button>
      </div>
      {copied && (
      <div className="fixed bottom-6 right-6 z-50">
        <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white shadow-lg animate-fade-in">
          <span>Wallet address copied</span>
        </div>
  </div>
)}

    </div>
  );
}

function Action({
  label,
  primary = false,
}: {
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      className={`py-2 rounded-lg text-sm font-medium transition ${
        primary
          ? "bg-blue-600 text-white hover:bg-blue-700"
          : "bg-blue-50 text-blue-600 hover:bg-blue-100"
      }`}
    >
      {label}
    </button>
  );
}

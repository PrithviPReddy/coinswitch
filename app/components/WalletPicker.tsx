"use client";

import { useState } from "react";
import type { Wallet } from "../hooks/useWallets";

const explorerAddress = (address: string) =>
  `https://solscan.io/account/${address}?cluster=devnet`;

/**
 * The wallet panel: which wallet the terminal is pointed at, and the two
 * things you can do to the set of them. There is no import control, because
 * keys here are generated server side and never accepted from outside.
 */
export default function WalletPicker({
  wallets,
  selected,
  limit,
  onSelect,
  onCreate,
  onRename,
  onFund,
  creating,
  funding,
}: {
  wallets: Wallet[];
  selected: Wallet;
  limit: number;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, label: string) => void;
  onFund: () => void;
  creating: boolean;
  funding: boolean;
}) {
  // Reset on wallet switch is handled by the caller keying this component on
  // the wallet id, so there is no effect here syncing a draft to a prop.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(selected.label);

  const atLimit = wallets.length >= limit;

  function commitRename() {
    const trimmed = draft.trim();

    if (trimmed && trimmed !== selected.label) onRename(selected.id, trimmed);
    else setDraft(selected.label);

    setRenaming(false);
  }

  return (
    <div className="panel p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base text-ink">Wallet</h2>
        <span className="figure text-[11px] text-ink-faint">
          {wallets.length} of {limit}
        </span>
      </div>

      {renaming ? (
        <input
          autoFocus
          value={draft}
          maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(selected.label);
              setRenaming(false);
            }
          }}
          className="mt-3 w-full rounded-[6px] border border-emerald px-3 py-2.5 text-sm text-ink outline-none"
        />
      ) : (
        <select
          value={selected.id}
          onChange={(e) => onSelect(e.target.value)}
          className="mt-3 w-full rounded-[6px] border border-rule bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-emerald"
        >
          {wallets.map((wallet) => (
            <option key={wallet.id} value={wallet.id}>
              {wallet.label}
            </option>
          ))}
        </select>
      )}

      <div className="mt-2.5 flex items-center gap-4">
        <button
          onClick={() => {
            // Seeded here rather than held in sync, so a rename that failed
            // and rolled back does not reopen showing the rejected name.
            setDraft(selected.label);
            setRenaming(true);
          }}
          disabled={renaming}
          className="text-xs text-ink-faint hover:text-emerald disabled:opacity-40"
        >
          Rename
        </button>
        <button
          onClick={onCreate}
          disabled={creating || atLimit}
          title={atLimit ? `${limit} wallets is the limit` : undefined}
          className="text-xs text-ink-faint hover:text-emerald disabled:opacity-40"
        >
          {creating ? "Creating" : "New wallet"}
        </button>
      </div>

      <a
        href={explorerAddress(selected.publicKey)}
        target="_blank"
        rel="noreferrer"
        className="figure mt-4 block break-all text-xs leading-relaxed text-ink-soft underline decoration-rule underline-offset-4 hover:text-emerald"
      >
        {selected.publicKey}
      </a>

      <button
        onClick={onFund}
        disabled={funding}
        className="mt-5 w-full rounded-[6px] border border-rule py-2 text-sm text-ink hover:border-emerald hover:text-emerald disabled:opacity-50"
      >
        {funding ? "Funding" : "Fund from vault"}
      </button>
    </div>
  );
}

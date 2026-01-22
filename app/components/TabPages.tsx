"use client"
/* eslint-disable */
import { useEffect, useState } from "react";
import { TokenWithBalance } from "../hooks/useTokens";
import { Loading } from "./DifferentPages";
import { SUPPORTED_TOKENS, SupportedToken, TokenDetails } from "../lib/constants";
import axios from "axios";
import { useJupiterQuote } from "../hooks/useJupiterQuote";

export  function Assets({tokenBalances, loading}: {
    publicKey: string;
    tokenBalances: {
        totalBalance: number,
        tokens: TokenWithBalance[]
    } | null;
    loading: boolean;
}) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (copied) {
            const timeout = setTimeout(() => {
                setCopied(false)
            }, 3000)
            return () => {
                clearTimeout(timeout);
            }
        }
    }, [copied])

    if (loading) {
        return <Loading/>
    }

    return <TokenList tokens={tokenBalances?.tokens || []} />
}

export function TokenList({ tokens }: { tokens: TokenWithBalance[] }) {
  return (
    <div className="mt-6 rounded-2xl bg-white shadow-sm">
      <div className="px-6 py-4 border-b text-sm font-medium text-slate-500">
        Assets
      </div>

      <div className="divide-y">
        {tokens.map((t) => (
          <TokenRow key={t.mint} token={t} />
        ))}
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: TokenWithBalance }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition">
      {/* Left */}
      <div className="flex items-center gap-3">
        <img
          src={token.image}
          alt={token.name}
          className="h-10 w-10 rounded-full border"
        />

        <div>
          <div className="font-medium text-slate-900">
            {token.name}
          </div>
          <div className="text-xs text-slate-500">
            1 {token.name} ≈ ${token.price.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Right */}
      <div className="text-right">
        <div className="font-semibold text-slate-900">
          ${token.usdBalance.toFixed(2)}
        </div>
        <div className="text-xs text-slate-500">
          {token.balance.toFixed(4)}
        </div>
      </div>
    </div>
  );
}

export function Swap({tokenBalances, publicKey}: {
    publicKey: string;
    tokenBalances: {
        totalBalance: number,
        tokens: TokenWithBalance[]
    } | null;
}){

    const [baseAsset , setBaseAsset]  = useState<SupportedToken>(SUPPORTED_TOKENS[0])
    const [quoteAsset, setQuoteAsset]  = useState<SupportedToken>(SUPPORTED_TOKENS[2])
    const [baseAmount, setBaseAmount] = useState<string | null>()
    //@ts-ignore
    const { quoteAmount, setQuoteAmount,loading } = useJupiterQuote({baseAsset,quoteAsset,baseAmount})
                                  


    
    return (
  <div className="relative max-w-md mx-auto bg-white rounded-2xl shadow-sm p-4 space-y-3">
    {/* Base asset */}
    <SwapInputRow
      amount = {baseAmount!}
      onAmountChange ={(value : string) => {
        setBaseAmount(value)
      }}
      selectedToken={baseAsset}
      otherSelectedToken={quoteAsset}
      onSelect={setBaseAsset}
      showBalance = {true}
      tokenBalances={tokenBalances}
      
    />

    {/* Swap button */}
    <div className="flex justify-center">
      <button
        onClick={() => {
          setBaseAsset(quoteAsset);
          setQuoteAsset(baseAsset);
          setBaseAmount(null)
          setQuoteAmount(null)
        }}
        className="z-10 flex items-center justify-center h-8 w-8 rounded-full border bg-white text-slate-600 hover:bg-slate-100 transition shadow-sm"
        aria-label="Swap tokens"
      >
        ⇅
      </button>
    </div>

    {/* Quote asset */}
    <SwapInputRow
      amount = {quoteAmount!}
      selectedToken={quoteAsset}
      otherSelectedToken={baseAsset}
      onSelect={setQuoteAsset}
    />
  </div>
);


}

function SwapInputRow({
  amount,
  onAmountChange,
  selectedToken,
  otherSelectedToken,
  onSelect,
  showBalance = false,
  tokenBalances,
}: {
  amount? : string
  onAmountChange? : (value:string) => void
  selectedToken: SupportedToken;
  otherSelectedToken: SupportedToken;
  onSelect: (asset: SupportedToken) => void;
  showBalance?: boolean;
  tokenBalances?: {
    tokens: TokenWithBalance[];
  } | null
}) {
  const tokenBalance = showBalance
    ? tokenBalances?.tokens.find((t) => t.mint === selectedToken.mint)
    : null

  return (
    <div className="relative border rounded-xl p-4 bg-white">
      <div className="flex justify-between items-center">
        <AssetSelector
          selectedToken={selectedToken}
          disabledMint={otherSelectedToken.mint}
          onSelect={onSelect}
        />

        <input
          type="number"
          placeholder="0.00"
          className="text-right text-lg font-medium outline-none w-32"
          value = {amount ?? ''}
          onChange={(e) => {
            onAmountChange?.(e.target.value)
          }}
        />
      </div>

      {showBalance && tokenBalance && (
        <div className="mt-2 text-xs text-slate-500">
          You currently have{" "}
          <span className="font-medium text-slate-700">
            {tokenBalance.balance.toFixed(4)} {selectedToken.name}
          </span>{" "}
          in your wallet
        </div>
      )}
    </div>
  );
}


export function AssetSelector({
  selectedToken,
  disabledMint,
  onSelect,
}: {
  selectedToken: SupportedToken;
  disabledMint?: string;
  onSelect: (token: SupportedToken) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      {/* Selected value */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium bg-slate-50 hover:bg-slate-100 transition"
      >
        <img
          src={selectedToken.image}
          alt={selectedToken.name}
          className="h-5 w-5 rounded-full"
        />
        <span>{selectedToken.name}</span>
        <span className="ml-1 text-slate-400">▾</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-2 w-full rounded-xl border bg-white shadow-lg">
          {SUPPORTED_TOKENS.map((token) => {
            const disabled = token.mint === disabledMint;

            return (
              <button
                key={token.mint}
                disabled={disabled}
                onClick={() => {
                  onSelect(token);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition
                  ${
                    disabled
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:bg-slate-50"
                  }`}
              >
                <img
                  src={token.image}
                  alt={token.name}
                  className="h-5 w-5 rounded-full"
                />
                <span>{token.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

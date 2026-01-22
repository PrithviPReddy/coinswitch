"use client";
/* eslint-disable */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loading, Warning } from "./DifferentPages";
import { TabButton } from "./Button";
import { useTokens } from "../hooks/useTokens";
import { Assets, Swap } from "./TabPages";

type Tab = "token" | "send" | "add_funds" | "swap" | "withdraw"
const tabs : { id : Tab , name : string}[] = [
  {id:"token", name: "Tokens"},
  {id:"send", name: "Send"},
  {id:"add_funds", name: "Add Funds"},
  {id:"swap", name: "Swap"},
  {id:"withdraw", name: "Withdraw"},

]

export function ProfileCard({ publicKey }: { publicKey: string }) {
  const { data: session, status } = useSession();
  const router = useRouter()
  const [copied,setCopied] = useState(false)
  const [selectedTab, setSelectedTab] = useState<Tab>("token")
  const { tokenBalances, loading } = useTokens(publicKey);

 if (status === "loading") {return <Loading/>}

  if ( !session?.user ) {
        router.push("/")
        return null
  }

  

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
            Welcome back, {session?.user?.name?.split(" ")[0] || "User"}
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
          <p className="text-4xl font-bold text-slate-900">${Number(tokenBalances?.totalBalance.toFixed(3))}</p>
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
            setTimeout(() => setCopied(false),1000)
          }}
          className="ml-4 text-blue-600 hover:underline text-xs"
        >
          Copy
        </button>
      </div>

      {/* Actions */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-3">
                {tabs.map(tab => <TabButton key={tab.id} active={tab.id === selectedTab} onClick={() => {
                    setSelectedTab(tab.id)
                }}>{tab.name}</TabButton>)}
      </div>

      {/* Assets */}
      <div className="mt-10 border-t pt-6 text-center text-slate-500">
        <div className={`${selectedTab === "token" ? "visible" : "hidden"}`}><Assets tokenBalances={tokenBalances} loading={loading} publicKey={publicKey} /> </div>
            <div className={`${selectedTab === "swap" ? "visible" : "hidden"}`}><Swap tokenBalances={tokenBalances} publicKey={publicKey} /> </div>
            <div className={`${(selectedTab !== "swap" && selectedTab !== "token") ? "visible" : "hidden"}`}><Warning /> </div>
        <button
          onClick={() => {
            window.open("https://faucet.solana.com/", "_blank", "noopener,noreferrer");
          }}
          className="mt-5 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
        >
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

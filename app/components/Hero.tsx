"use client";

import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";

export default function Hero() {
  const { data: session } = useSession();

  return (
    <main className="min-h-screen bg-[#f6fbff]">
      {/* Hero Section */}
      <section className="max-w-7xl mx-auto px-6 pt-24 text-center">
        <h1 className="text-4xl md:text-6xl font-bold text-gray-900 leading-tight">
          The crypto of tomorrow,{" "}
          <span className="text-blue-600">today</span>
        </h1>

        <p className="mt-6 text-lg text-gray-600 max-w-2xl mx-auto">
          Trade, store, and manage digital assets on DCEX with a seamless,
          secure, and modern exchange experience.
        </p>

        <div className="mt-10 flex justify-center gap-4">
          {/* Auth-aware buttons */}
          {!session?.user ? (
            <>
              <button
                onClick={() => signIn("google")}
                className="flex items-center gap-2 px-6 py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition"
              >
                Sign up with Google
              </button>

              <Link
                href="/signin"
                className="px-6 py-3 rounded-lg border border-gray-300 font-medium text-gray-700 hover:bg-gray-100 transition"
              >
                Login
              </Link>
            </>
          ) : (
            <div></div>
          )}
        </div>
      </section>

      {/* Feature Cards */}
      <section className="max-w-6xl mx-auto px-6 mt-24 grid gap-6 md:grid-cols-3">
        <FeatureCard
          title="DCEX Wallet"
          description="A simple, secure wallet built directly into the exchange."
        />
        <FeatureCard
          title="DCEX Pro"
          description="High-performance trading tools for advanced users."
        />
        <FeatureCard
          title="DCEX API"
          description="Build and automate trading strategies with powerful APIs."
        />
      </section>

      {/* Mock Preview */}
      <section className="max-w-6xl mx-auto px-6 mt-24">
        <div className="bg-white rounded-2xl shadow-lg p-6">
          <div className="h-64 md:h-96 rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center text-gray-400 text-sm">
            Trading Dashboard Preview
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mt-32 py-10 border-t text-center text-sm text-gray-500">
        © {new Date().getFullYear()} DCEX. All rights reserved.
      </footer>
    </main>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm hover:shadow-md transition">
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-gray-600 text-sm">{description}</p>
    </div>
  );
}

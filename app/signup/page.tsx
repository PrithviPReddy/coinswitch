"use client";

import Link from "next/link";
import { useState } from "react";
import { GoogleSignInButton} from "../components/Button";

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6fbff] px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-md p-8">
        {/* Heading */}
        <h1 className="text-2xl font-semibold text-slate-900 text-center">
          Sign in to DCEX
        </h1>
        <p className="mt-2 text-sm text-slate-600 text-center">
          Access your account securely
        </p>

        {/* Form */}
        <div className="mt-8 space-y-4">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Buttons */}
        <div className="mt-6 flex gap-3">
          <button
            className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 transition"
          >
            Sign in
          </button>

          <GoogleSignInButton/>
        </div>

        {/* Footer */}
        <p className="mt-6 text-center text-sm text-slate-600">
          Create account?{" "}
          <Link
            href="/signup"
            className="text-blue-600 font-medium hover:underline"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

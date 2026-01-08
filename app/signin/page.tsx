"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { GoogleSignInButton } from "../components/Button";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6fbff] px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-md">
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
            Login
          </button>

          <GoogleSignInButton/>
        </div>

        {/* Create account */}
        <p className="mt-6 text-center text-sm text-gray-600">
          Create account?{" "}
          <Link
            href="/signup"
            className="font-medium text-blue-600 hover:underline"
          >
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

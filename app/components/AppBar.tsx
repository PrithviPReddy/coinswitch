"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function AppBar() {
  const { data: session } = useSession();
  const router = useRouter()

  return (
    <div className="border-b px-4 py-3 flex justify-between items-center">
      {/* Logo */}
      <button
      onClick={() => {
        if (session?.user) {
          router.push("/dashboard");
        } else {
          router.push("/");
        }
      }}
      className="text-xl font-bold tracking-wide cursor-pointer"
    >
      DCEX
    </button>

      {/* Auth Actions */}
      <div className="flex items-center gap-3">
        {!session?.user ? (
          <>
            <Link
              href="/signin"
              className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 hover:bg-gray-100 transition"
            >
              Login
            </Link>

            <Link
              href="/signup"
              className="px-4 py-2 text-sm font-medium rounded-md bg-black text-white hover:bg-gray-800 transition"
            >
              Sign up
            </Link>
          </>
        ) : (
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="px-4 py-2 text-sm font-medium rounded-md border border-red-300 text-red-600 hover:bg-red-50 transition"
          >
            Logout
          </button>
        )}
      </div>
    </div>
  );
}

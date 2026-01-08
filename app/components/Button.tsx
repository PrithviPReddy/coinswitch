"use client"

import { signIn } from "next-auth/react"



export function GoogleSignUpButton(){
    return <button
            onClick={() => signIn("google")}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-gray-300 py-2 text-sm font-medium hover:bg-gray-100 transition"
          >
            <span className="font-bold text-blue-600">G</span>
            Sign Up with Google
          </button>
}

export function GoogleSignInButton(){
    return <button
            onClick={() => signIn("google")}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-gray-300 py-2 text-sm font-medium hover:bg-gray-100 transition"
          >
            <span className="font-bold text-blue-600">G</span>
            Sign In with Google
          </button>
}
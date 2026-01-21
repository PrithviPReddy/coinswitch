"use client"

import { signIn } from "next-auth/react"



export function GoogleSignUpButton(){
    return <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" }) }
            className="w-full flex items-center justify-center gap-2 rounded-md border border-gray-300 py-2 text-sm font-medium hover:bg-gray-100 transition"
          >
            <span className="font-bold text-blue-600">G</span>
            Sign Up with Google
          </button>
}

export function GoogleSignInButton(){
    return <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-gray-300 py-2 text-sm font-medium hover:bg-gray-100 transition"
          >
            <span className="font-bold text-blue-600">G</span>
            Sign In with Google
          </button>
}

export const TabButton = ({active, children, onClick}: {
    active: boolean;
    children: React.ReactNode,
    onClick: () => void
}) => {
    return <button type="button" className={`py-2 rounded-lg text-sm font-medium transition ${active ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-blue-50 text-blue-600 hover:bg-blue-100"}`} onClick={onClick}>{children}</button>
}

export const PrimaryButton = ({children, onClick}: {
    children: React.ReactNode,
    onClick: () => void
}) => {
    return <button onClick={onClick} type="button" className="text-white bg-gray-800 hover:bg-gray-900 focus:outline-none focus:ring-4 focus:ring-gray-300 font-medium rounded-lg text-sm px-5 py-2.5 me-2 mb-2">
        {children}
    </button>
}
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import db from "@/app/db";
import { createWalletForUser } from "@/app/lib/wallets";
import { Session } from "next-auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface session extends Session {
  user: {
    email: string;
    name: string;
    image: string;
    uid: string;
  };
}

const DEMO_USERNAME = process.env.DEMO_USERNAME ?? "demo@coinswitch.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "review2";

/**
 * Every account gets a custodial devnet keypair on first sign-in. This is a
 * deliberate demo-scoped choice: it keeps the flow to one click with no
 * browser wallet to install, and it is why the server can sign. It is also
 * why the keys here are devnet-only and worthless.
 *
 * The first wallet is created through the same helper the terminal's create
 * button uses, so an account's first wallet is not a special case: it is
 * Wallet 1, and the second one made later is Wallet 2.
 */
async function findOrCreateUser(username: string, provider: "Google" | "Demo", sub: string) {
  const existing = await db.user.findFirst({ where: { username } });
  if (existing) return existing;

  const user = await db.user.create({
    data: {
      username,
      provider,
      sub,
      inrWallet: { create: { balance: 0 } },
    },
  });

  await createWalletForUser(user.id);

  return user;
}

export const authConfig = {
  secret: process.env.NEXTAUTH_SECRET || "dev-secret-change-me",
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      httpOptions: { timeout: 10000 },
    }),
    // Present so the demo does not depend on an OAuth round trip working on
    // the day. Same wallet creation path, same custodial model.
    CredentialsProvider({
      id: "demo",
      name: "Demo account",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (
          credentials?.username !== DEMO_USERNAME ||
          credentials?.password !== DEMO_PASSWORD
        ) {
          return null;
        }

        const user = await findOrCreateUser(DEMO_USERNAME, "Demo", "demo");

        return { id: user.id, name: "Demo account", email: DEMO_USERNAME };
      },
    }),
  ],
  session: { strategy: "jwt" as const },
  callbacks: {
    session: ({ session, token }: any): session => {
      const newSession = session as session;
      if (newSession.user && token.uid) {
        newSession.user.uid = token.uid ?? "";
      }
      return newSession;
    },
    async jwt({ token, account, user }: any) {
      if (account?.provider === "demo" && user?.id) {
        token.uid = user.id;
        return token;
      }

      if (token.uid) return token;

      const dbUser = await db.user.findFirst({
        where: account?.providerAccountId
          ? { sub: account.providerAccountId }
          : { username: token.email ?? "" },
      });

      if (dbUser) token.uid = dbUser.id;
      return token;
    },
    async signIn({ user, account }: any) {
      if (account?.provider === "demo") return true;

      if (account?.provider === "google") {
        if (!user.email) return false;
        await findOrCreateUser(user.email, "Google", account.providerAccountId);
        return true;
      }

      return false;
    },
  },
};

import GoogleProvider from "next-auth/providers/google";
import { Keypair } from "@solana/web3.js";
import db from "@/app/db";
import { NextAuthOptions } from "next-auth";

export const authConfig: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false;

      const email = user.email;
      if (!email) return false;

      const existingUser = await db.user.findFirst({
        where: {
          username: email,
        },
      });

      if (existingUser) return true;

      const keyPair = Keypair.generate();

      await db.user.create({
        data: {
          username: email,
          provider: "Google",
          solWallet: {
            create: {
              publicKey: keyPair.publicKey.toBase58(),
              privateKey: Buffer.from(keyPair.secretKey).toString("base64"),
            },
          },
          inrWallet: {
            create: {
              balance: 0,
            },
          },
        },
      });

      return true;
    },
  },

  secret: process.env.NEXTAUTH_SECRET || "test"
};

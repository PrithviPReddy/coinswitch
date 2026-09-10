import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authConfig, type session as AppSession } from "../lib/auth";
import { listWallets, MAX_WALLETS_PER_USER } from "../lib/wallets";
import Terminal from "../components/Terminal";

export default async function Dashboard() {
  const session = (await getServerSession(authConfig)) as AppSession | null;

  if (!session?.user?.uid) redirect("/signin");

  // Fetched on the server so the first paint already knows which wallets
  // exist. Private keys never leave listWallets.
  const wallets = await listWallets(session.user.uid);

  if (!wallets.length) {
    return (
      <main className="mx-auto max-w-md px-6 py-20">
        <h1 className="text-2xl text-ink">No wallet on this account</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Sign out and back in to have a devnet wallet created, or check that
          the database migration ran.
        </p>
      </main>
    );
  }

  return <Terminal wallets={wallets} walletLimit={MAX_WALLETS_PER_USER} />;
}

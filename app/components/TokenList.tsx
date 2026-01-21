import { TokenWithBalance } from "../hooks/useTokens";

export function TokenList({ tokens }: { tokens: TokenWithBalance[] }) {
  return (
    <div className="mt-6 rounded-2xl bg-white shadow-sm">
      <div className="px-6 py-4 border-b text-sm font-medium text-slate-500">
        Assets
      </div>

      <div className="divide-y">
        {tokens.map((t) => (
          <TokenRow key={t.mint} token={t} />
        ))}
      </div>
    </div>
  );
}

function TokenRow({ token }: { token: TokenWithBalance }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition">
      {/* Left */}
      <div className="flex items-center gap-3">
        <img
          src={token.image}
          alt={token.name}
          className="h-10 w-10 rounded-full border"
        />

        <div>
          <div className="font-medium text-slate-900">
            {token.name}
          </div>
          <div className="text-xs text-slate-500">
            1 {token.name} ≈ ${token.price.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Right */}
      <div className="text-right">
        <div className="font-semibold text-slate-900">
          ${token.usdBalance.toFixed(2)}
        </div>
        <div className="text-xs text-slate-500">
          {token.balance.toFixed(4)}
        </div>
      </div>
    </div>
  );
}

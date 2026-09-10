/**
 * The dark card that appears after something settles. Swaps and sends report
 * different figures but the shape is the same: what happened, then the
 * signature that proves it.
 */
export default function TxReceipt({
  title,
  rows,
  signature,
  explorerUrl,
}: {
  title: string;
  rows: { term: string; value: string; accent?: boolean }[];
  signature: string;
  explorerUrl: string;
}) {
  return (
    <div className="receipt-in mt-8 rounded-[6px] bg-ink p-7 text-paper">
      <h2 className="font-serif text-lg text-paper">{title}</h2>

      <dl className="mt-6 space-y-3 text-sm">
        {rows.map((row) => (
          <div
            key={row.term}
            className="flex items-baseline justify-between gap-6"
          >
            <dt className="text-white/60">{row.term}</dt>
            <dd
              className={`figure text-right ${row.accent ? "text-emerald" : "text-paper"}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-7 border-t border-white/15 pt-5">
        <p className="text-xs text-white/50">Transaction signature</p>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="figure mt-2 block break-all text-xs leading-relaxed text-emerald underline decoration-emerald/40 underline-offset-4"
        >
          {signature}
        </a>
      </div>
    </div>
  );
}

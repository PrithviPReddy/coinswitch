# CoinSwitch

A Solana token swap application that quotes against mainnet liquidity and
settles on devnet, so every trade produces a real transaction signature that
resolves on Solscan.

## Why two networks

Jupiter's routers only have liquidity on mainnet. Its program is deployed on
devnet under the same address and the same API endpoints serve both, but
almost every pair returns no route there, so a devnet quote is an empty
response rather than a cheap one.

Rather than pretend otherwise, the two halves are split:

| Stage | Network | What happens |
| --- | --- | --- |
| Quote | mainnet | Jupiter returns a route, an expected output and a price impact figure |
| Record | database | The quoted figure is written to the swap log before anything is signed |
| Settle | devnet | One transaction moves the input to the vault and the output back |
| Verify | devnet | The delivered amount is read from account state and shown beside the quote |

Settlement uses two SPL mints this project creates itself, held by a vault
keypair that acts as counterparty. Both transfers sit in a single transaction,
so either the swap completes or nothing moves.

This is not an automated market maker and should not be described as one. It
is devnet settlement against a project-operated vault, priced from live
mainnet quotes.

## Simulated fills: what is real and what is modelled

Settlement is against a project vault on devnet, so there is no real market
on the settling side. By default (`FILL_MODE=simulated`) the vault pays out
a **simulated fill**: the server's mainnet quote, moved by one draw from the
recorded distribution of mainnet quote drift. Every such fill is labelled
"simulated fill" on the receipt and "sim" in the settlement log.

| | Real | Modelled |
|---|---|---|
| Quote, route, price impact | Jupiter mainnet, fetched by the server at swap time | — |
| Settlement transaction | Devnet, signed and confirmed; signature on Solscan | — |
| Tokens | — | Devnet stand-ins this project mints (USDC, USDT, JUP, BONK, WIF), priced from mainnet |
| Payout vs quote | — | A draw from recorded mainnet quote drift (below) |
| MEV / extraction | — | **Not modelled.** It was never measured, so it is not simulated. It is a known cost this project leaves out |

How the draw works:

- The **sampler** (`scripts/sampler`) asks Jupiter for the same quote again
  5, 15, 30 and 60 s later and records how much it moved (`QuoteDrift`).
  This is the only data the fill model uses. Nothing is synthesised.
- `npm run build:fill-model` turns that into `models/fill-model.json`:
  101-point empirical quantiles per bucket (pair × size × 30-minute realised
  volatility), each bucket requiring at least 20 observations. Sparse
  buckets fall back to pair × size, then pair, then a global bucket for the
  swap's depth class, so a thin-token swap never draws from deep-pair data.
- At swap time the app picks the drift horizon nearest the measured
  quote-to-confirmation latency of recent swaps (in practice +5 s). It finds
  the most specific bucket with enough data and draws once. The draw is
  **two-sided**: some simulated fills land above the quote.
- The user's slippage cap is enforced against that draw. A simulated fill
  below `quoted × (1 − slippageBps/10 000)` is recorded Failed, "slippage
  bound exceeded", and nothing is signed.
- Every swap row records the fill mode, the draw, the model version, the
  fallback level and bucket, the horizon, the latency estimate and the
  volatility it used.
- With no artifact, or a malformed one, the app logs loudly and settles at
  exactly the quote. It never invents a distribution.

What to expect: on the deep pairs (SOL, USDC, USDT) quote drift over a few
seconds is a few bps either way, so a 50 bps cap almost never binds. That is
the correct result for those markets, not a bug. The cap only bites on the
thin pairs, which is why JUP, BONK and WIF are in the app.

A simulated fill is a modelled payout on devnet. It is not observed market
execution, and nothing here should be read as measured slippage.

### What the thin-pair cost figures mean

The impact figures for JUP, BONK and WIF are the cost of **naive on-chain
execution**: one market order routed through Jupiter's on-chain AMM
liquidity, as priced by its `swap/v1` quote. That quote does not see RFQ
market makers, OTC desks or centralised venues, which is where a real
$200k–$1M order in these tokens would go. So "selling $1M of BONK costs about
85%" means **sending it as one on-chain swap** costs about 85%. It does not
mean trading that size in BONK costs that much in general. Nobody sensible
would execute it that way, and showing that is exactly what the advisor is
for.

## What the cost model found

The cost model (`notebooks/train_cost_model.ipynb`, served by
`app/lib/costModel.ts`) has three targets. Its findings, from a time-based
train/test split with deep and thin pairs reported separately:

1. **Price impact is predictable from size and depth.** A power law per pair
   beats a ridge baseline on thin pairs by a wide margin (reference fit: test
   MAE 189 vs 1,038 bps, n=986). On deep pairs, where impact is a few bps at
   most, the two are about even.
2. **Short-horizon drift is not predictable beyond its mean at this data
   scale.** A ridge on horizon and realised volatility does *worse* out of
   sample than predicting the training mean (reference fit: deep MAE 2.55 vs
   2.35 bps, n=215; thin 2.54 vs 2.33 bps, n=216). This is a finding, not a
   gap waiting to be filled with more features: over seconds, the price moves
   about as much as it usually does, and knowing recent volatility does not
   say which way or by how much more.
3. **Failure probability is still estimable** (P(drift beats the cap)),
   empirically from the recorded drift distribution, even though conditional
   prediction of drift fails. It is reported with a calibration table.

This is also why the advisor works where it matters. Its cost is dominated
by impact precisely in the cases where its advice differs from "send it now",
which are large orders in thin pools. Impact is the part the model predicts
well.

(Figures above are from the TypeScript reference fit,
`models/cost-model.example.json`. The Colab model's figures replace them in
the final report.)

## The execution-mode advisor

`app/lib/advisor.ts` prices four modes, all in bps of notional:

  C(m) = impact + execution drift + waiting drift + p(fail) · φ + fees

| Mode | What it does |
|---|---|
| SEND_NOW | one order at full size |
| SPLIT(k, W) | k portions over W seconds, each with its own fresh quote and the user's cap |
| TIGHTEN_AND_RETRY(c, R) | a tighter cap c, retried up to R times |
| DEFER | wait, when the time-varying part of the cost is elevated against its own norm |

- **φ is what a failed fill actually loses**: its fee ($0.002 assumed) plus
  the expected adverse drift over one ~5 s retry cycle. On a large order it
  is negligible ($0.002 on $200k is 0.0001 bps). It does no real work there,
  and the write-up does not pretend otherwise.
- **Cost is split into structural (impact and fees: depth) and transient
  (drift and failure: volatility).** DEFER looks only at the transient part,
  because waiting does not fix depth. When an order is expensive because the
  pool is thin, the advisor says so: *this cost is structural — waiting will
  not help.* A user's maximum acceptable cost is a separate check.
- **Every prediction carries a coverage flag** (`ok`, `sparse`, `fallback`,
  `extrapolated`, `none`). The advice is marked low confidence when any part
  of it comes from thin or borrowed data.

### Pool recovery is unmeasured, so the result is a bracket

SPLIT only saves money if the pool recovers between portions: if the next
portion lands on a pool still displaced by the last one, it pays most of
the same impact again. The share of displacement that has decayed between
portions is the **recovery fraction ρ**. At ρ = 1 every portion pays impact
at its own size (the optimistic bound). At ρ = 0 the portions together pay
exactly what one order would, and splitting saves nothing.

**ρ is not measured, and cannot be measured from this dataset.** The
sampler only ever *asks* for quotes; it never trades. So no recorded quote
was ever moved by an order of ours, and there is nothing to watch recover.
Measuring ρ needs a pool to be displaced and then observed:

- **by trading:** execute real mainnet swaps of known size on the thin
  pools, then re-quote the same size every second or so for a minute, and
  measure how much of the displacement remains at each interval; or
- **without trading:** an event study on other people's large swaps. Watch
  the chain for large swaps in these pools, re-quote immediately and at
  intervals afterwards, and fit the decay. This needs a chain subscription
  and a faster sampler, but no capital at risk.

Until then, the backtest reports every SPLIT result **across ρ from 0 to 1**:
the saving at both bounds, the saving as a function of ρ, the breakeven ρ at
which splitting stops paying, and whether the advisor's choice flips
between the bounds.

## Backtest

```bash
npm run backtest                  # models/cost-model.json, else the example artifact
npm run backtest -- path/to/model.json
```

This replays the real TypeScript advisor over **held-out** recorded quotes:
orders after the model's training cutoff, at every recorded rung size. What
each mode would have cost is read from the recorded series. The advisor is
compared with always-SEND_NOW (the control) and a fixed 4-way split, across
ρ ∈ [0, 1], with deep and thin pairs separate.

The output in `reports/backtest/` covers: the mean and median saving, the
distribution, failure rates, fee spend, the share of orders where the
advisor did worse than the control, whether deferring actually helped, the
breakeven ρ by size, and the low-confidence count per row. The summary
names the artifact that produced it.

## Setup

Requires Docker and Node 22.

```bash
cp .env.example .env
npm install
npm run setup:devnet     # creates the vault and the two mints, prints env values
```

Paste the three printed values (`DEVNET_USDC_MINT`, `DEVNET_USDT_MINT`,
`VAULT_SECRET_KEY`) into `.env`, then:

```bash
docker compose up --build
```

The app is on http://localhost:3000. Sign in with the demo credentials from
`.env`, press **Fund from vault**, and swap.

The setup script is safe to re-run. It reuses `.vault.json` if one exists, so
your mints and vault survive a rebuild.

### Running without Docker

```bash
docker compose up -d postgres
npx prisma migrate deploy
npm run dev
```

## Demo path

1. Sign in with the demo account (no OAuth round trip needed).
2. **Fund from vault** — sends devnet SOL and 500 of each project token to
   the selected wallet.
3. Enter an amount. The quote, route and price impact come from mainnet.
4. **Swap**. The receipt shows quoted against delivered, with the signature.
5. Click the signature to open the transaction on Solscan devnet, where both
   transfer instructions are visible inside one transaction.
6. The settlement log keeps every swap with its explorer link, scoped to the
   wallet you are looking at.
7. **New wallet** creates a second devnet wallet on the same account. It
   starts empty, so fund it before swapping from it.
8. The **Send** tab moves tokens straight out to any devnet address, or to
   another of your own wallets in one click.

## Wallets

An account holds up to five devnet wallets. The first is created at sign-in;
the rest come from **New wallet** in the terminal. Balances, the swap you are
about to make and the settlement log all follow the wallet selected in the
sidebar, so the numbers on screen always belong to the wallet a swap would
debit.

There is no import. Keys are generated server side and stored by this project,
which is what lets the server sign a settlement without a browser wallet;
accepting an outside key would mean custody of a secret this project did not
create. Every key here controls worthless devnet tokens and nothing else.

The five-wallet cap is `MAX_WALLETS_PER_USER`. It exists because every wallet
can call **Fund from vault**, and the vault is refilled by a rate-limited
faucet.

## Sending

The **Send** tab beside **Swap** transfers a token out of the selected wallet
to any devnet address. There is no quote and no counterparty: the amount that
leaves is the amount that arrives.

The vault signs as fee payer here, as it does for swaps. Two things follow
from that. A wallet holding no SOL can still send its tokens, and a SOL
balance can be sent down to zero, because nothing is held back for the fee.
If the recipient has never held the token, their associated token account is
created in the same transaction at the vault's expense, so sending to a fresh
address behaves like sending to a funded one.

Amounts are checked against devnet account state at request time rather than
against the balance the interface happens to be showing. Sends are recorded
before signing, the same way swaps are, and each wallet's history is listed
under the tab.

## Known limitations

- Wallets are custodial and every private key, on every wallet an account
  creates, is stored unencrypted in Postgres. This is a devnet demo decision
  that keeps the flow to one click with no browser wallet; the keys control
  worthless test tokens. It is not a design suitable for real funds.
- Settlement is vault-based, so there is no on-chain price impact on the
  devnet side. Price impact shown in the interface is mainnet's, from the
  quote.
- The public devnet faucet rate limits. If `setup:devnet` cannot fund the
  vault, fund it manually and re-run.

## Layout

```
app/
  api/quote      mainnet quotes through Jupiter
  api/swap       records the quote, settles on devnet, reads the result back
  api/swaps      settlement history
  api/send       transfers a token out to any devnet address
  api/transfers  outbound transfer history
  api/fund       tops a wallet up from the vault
  api/tokens     devnet balances priced with mainnet prices
  api/wallets    list, create and rename an account's wallets
  lib/devnet     vault handling, atomic settlement and outbound transfers
  lib/wallets    wallet creation and the per-request ownership check
  components     interface
scripts/
  setup-devnet.mjs   creates the vault and the project mints
```

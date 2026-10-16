# CoinSwitch

A Solana token swap application that quotes against mainnet liquidity and
settles on devnet, so every trade produces a real transaction signature that
resolves on Solscan. Around it sits a measurement project: a sampler that
records mainnet quotes, a cost model trained on them, an execution-mode
advisor that uses the model, and a backtest of that advisor on held-out data.

Mainnet is read-only throughout. Nothing here ever signs a mainnet
transaction.

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
| Read back | devnet | The output balance is read before and after confirmation, and the difference is shown beside the quote |

Settlement uses five SPL mints this project creates itself (stand-ins for
USDC, USDT, JUP, BONK and WIF), held by a vault keypair that acts as
counterparty. Both transfers sit in a single transaction, so either the swap
completes or nothing moves.

The read-back shows what the vault paid. The app decides that amount, from
the quote or a labelled simulated fill (below). It is not a market fill.

This is not an automated market maker and should not be described as one. It
is devnet settlement against a project-operated vault, priced from live
mainnet quotes.

## Architecture

```
                    mainnet (read-only: quotes and prices, never a signature)
                    Jupiter swap/v1 quote · Jupiter price v3
                         ▲                              ▲
                         │ quote at swap time           │ ladders + re-quotes
                         │                              │
  browser ──► Next.js app (app/api/*)              sampler (docker service)
                 │    │                                 │
                 │    └──────────────► Postgres ◄───────┘
                 │                     Swap, QuoteSample, QuoteDrift, …
                 ▼                        │
     devnet: vault + 5 stand-in mints     │ npm run export:samples
     one atomic transaction per swap      ▼
                                     exports/*.csv.gz ──► Colab notebook
                                          │                    │
             npm run build:fill-model ◄───┘                    ▼
                    │                              models/cost-model.json
                    ▼                                          │
          models/fill-model.json                               ▼
          (simulated fills at swap time)       app/lib/advisor.ts ──► /api/advice
                                                               └────► npm run backtest
```

| Piece | Where | What it does |
| --- | --- | --- |
| Swap path | `app/api/swap`, `app/lib/swap.ts`, `app/lib/jupiter.ts`, `app/lib/devnet.ts` | Re-quotes on the server, records the quote, decides the fill, settles atomically on devnet, reads the result back. The signature is stored before broadcast; an unknown outcome is Pending, never Failed, and Pending swaps are reconciled against the chain when the log loads |
| Sampler | `scripts/sampler/`, compose service `sampler` | Records mainnet quote ladders and re-quotes (below) |
| Fill model | `scripts/build-fill-model.ts`, `app/lib/fillModel.ts`, `app/lib/fill.ts`, `app/lib/fillRuntime.ts` | Empirical drift quantiles, drawn once per swap |
| Cost model | `notebooks/train_cost_model.ipynb` (Colab), contract `models/cost-model.schema.json`, loader `app/lib/costModel.ts` | Impact, drift and failure probability, with coverage flags |
| Advisor | `app/lib/advisor.ts`, `app/api/advice`, `app/components/AdvicePanel.tsx` | Prices each execution mode and recommends one |
| Backtest | `scripts/backtest.ts` | Replays the advisor on held-out recorded quotes |

## The dataset

The sampler (`scripts/sampler`, running as the `sampler` service in
`docker-compose.yml`) asks Jupiter's mainnet `swap/v1` quote endpoint for
prices. It never trades.

- **Pairs.** Deep: SOL/USDC, USDC/SOL, SOL/USDT. Thin: JUP/USDC, BONK/USDC,
  WIF/USDC. (Before 08:29 UTC on 2026-10-16 a smaller deep-only set ran;
  those rows are kept and labelled by phase.)
- **Ladders.** Each pair is quoted at nine sizes fired together: deep pairs
  at 0.05, 0.25, 1, 5, 20, 100, 400, 2,000 and 10,000 SOL; thin pairs at $5,
  $25, $100, $500, $2k, $10k, $40k, $200k and $1M. Every row stores its USD
  notional, its route, and its measured impact against the same ladder's
  second rung (0.25 SOL or $25), whose route is stored too.
- **Drift.** Every second ladder re-quotes the ~$100 rung at +5, +15, +30
  and +60 s, and about one set in ten also re-quotes the ~$40k rung. Each
  re-quote stores its actual elapsed time.
- **Cadence and budget.** One cycle every 120 s (90 s with a dedicated key),
  behind a sliding-window limiter that serves ladder rungs first and keeps a
  slot in reserve so that the +5 s and +15 s re-quotes land on time.

At the backtest's data cut-off (2026-10-16 14:25 UTC) the dataset holds
**13,700 quote samples** (9,247 deep, 4,453 thin) and **3,439 drift rows**
(2,468 deep, 971 thin). That is about ten hours of deep-pair data and six of
thin-pair data, all from one day. See Limitations.

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

- The **sampler** asks Jupiter for the same quote again 5, 15, 30 and 60 s
  later and records how much it moved (`QuoteDrift`). This is the only data
  the fill model uses. Nothing is synthesised.
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
  exactly the quote. It never invents a distribution. The startup log prints
  the artifact's age and warns when it is over 12 hours old.

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

Every prediction carries a coverage flag: `ok`, `sparse` (fewer than 30
observations), `fallback` (borrowed from the pooled depth class, the reversed
pair or a default volatility), `extrapolated` (outside the measured sizes or
horizons) or `none`.

(Figures above are from the TypeScript reference fit,
`models/cost-model.example.json`. The Colab model's figures replace them in
the final report.)

## The execution-mode advisor

`app/lib/advisor.ts` prices each mode in bps of notional:

  C(m) = impact + execution drift + waiting drift + p(fail) · φ + fees

| Mode | What it does |
|---|---|
| SEND_NOW | one order at full size |
| SPLIT(k, W) | k portions over W seconds (k from 2 to 24, W from 30 s to 15 min, at least 10 s between portions), each with a fresh quote and the user's cap |
| TIGHTEN_AND_RETRY(c, R) | a tighter cap c, retried up to R times |
| DEFER | wait, when the time-varying part of the cost is elevated against its norm. **Off in the shipped advisor** (below) |

- **φ is what a failed fill actually loses**: its fee ($0.002 assumed) plus
  the expected adverse drift over one ~5 s retry cycle. On a large order it
  is negligible ($0.002 on $200k is 0.0001 bps). It does no real work there,
  and the write-up does not pretend otherwise.
- **Cost is split into structural (impact and fees: depth) and transient
  (drift and failure: volatility).** When most of an order's cost is
  structural, the advice says so: *this cost is structural — waiting will
  not help.* A user's maximum acceptable cost is a separate check.
- **Low confidence is carried through.** The advice is marked low
  confidence when any part of the chosen plan's prediction is not `ok`, and
  the app says which kind of gap it is.
- **When the best split is the largest the grid allows** (k = 24), the
  advice flags it: more portions might be cheaper still.

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
How it could be measured without trading is in Future Work.

Until then, the backtest reports every SPLIT result **across ρ from 0 to 1**:
the saving at both bounds, the saving as a function of ρ, the breakeven ρ at
which splitting stops paying, and whether the advisor's choice flips
between the bounds.

### Which ρ the advisor assumes: the regret analysis

The advisor has to assume some ρ to choose a plan. The backtest crosses the
two extremes: the advisor assumes ρ = 1 or ρ = 0, and the pool's true ρ is 1
or 0. Thin pairs, orders of about $10k and up (n = 620 held-out orders), at
a 50 bps cap; saved bps against always sending one order, median (mean,
worst 5%):

| advisor assumes | pool recovers fully (true ρ = 1) | pool never recovers (true ρ = 0) |
|---|---|---|
| **ρ = 1 (shipped)** | **+168.4** (mean +1,489, worst 5% +2.4) | **−1.0** (mean −2.4, worst 5% −74.1) |
| ρ = 0 | 0 (mean 0) | 0 (mean 0) |

At the 5 bps cap the picture is the same: +167.8 against −1.2 (mean −3.2,
worst 5% −76.5), and the ρ = 0 row has a mean of −0.8.

**The asymmetry holds.** Being wrong about ρ = 1 costs a median of about
1 bps, because at ρ = 0 the portions together pay the same impact as one
order: what splitting adds is only its extra fees and the price drift while
waiting. Being wrong about ρ = 0 forgoes a median of 168 bps per order (mean
1,489), because the advisor never splits. The breakeven ρ for these sizes is
0.06 or less, so splitting pays as long as pools recover even a few percent
of a portion's displacement between portions.

**The shipped advisor therefore assumes ρ = 1** (`recoveryFraction: 1` in
`DEFAULT_ADVISOR_PARAMS`), and the app says so beside every recommendation.

Two qualifications. The worst 5% of the downside is real: around 75 bps lost
when a split's waiting drift goes against it and the pool never recovers.
And the ρ = 0 bound assumes a split can never pay *more* impact than one
order. A real market can make it worse: portions that are visible on chain
can be front-run or sandwiched. That is extraction this project does not
model, so the downside column is the least that a wrong ρ = 1 can cost, not
the most.

### DEFER: implemented, tested, not supported

DEFER waits when the transient cost (drift and failure) is at least twice its
value at the pair's normal volatility and at least 1 bps above it. It is
implemented and unit-tested, and **off by default** (`deferEnabled: false`).
The backtest switches it on as an experiment and executes the deferred plan
at the pair's next recorded ladder:

| cap | depth | deferred | cheaper | dearer | mean gain, bps (95% CI) | median | worst / best |
|---|---|---|---|---|---|---|---|
| 50 bps | deep | 0 | — | — | — | — | — |
| 50 bps | thin | 161 | 74 | 61 | +1.4 (−7.7 to +7.1) | 0 | −96 / +50 |
| 5 bps | thin | 172 | 77 | 66 | +1.4 (−8.1 to +7.6) | 0 | −97 / +65 |

(Intervals are block bootstraps over 30-minute blocks of order time; the
deferrals fall in only 8 such blocks.)

**DEFER is not supported by the evidence.** The mean is indistinguishable
from zero, the median is zero, and deferring was cheaper in fewer than half
the cases. On an earlier, smaller held-out set the same experiment gave a
mean of −2.0 bps: the sign moves as data arrives. This is what the drift
finding predicts: DEFER triggers on volatility, and volatility does not
predict the direction or size of short-horizon drift. The transient and
structural split stays, because it decides what the advice says. When an
order is expensive because the pool is thin, *this cost is structural —
waiting will not help.*

### TIGHTEN_AND_RETRY at a tight cap

At a 50 bps cap the advisor never chooses TIGHTEN_AND_RETRY; no fill came
near the cap. The backtest therefore also runs at a **5 bps cap**, where
failures happen:

| 5 bps cap | chosen | mean saved, bps (95% CI) | beat control | worse | its failure rate | control's, same orders |
|---|---|---|---|---|---|---|
| deep | 1,092 of 1,092 | +0.13 (−0.35 to +0.49) | 162 | 166 | 4% | 4% |
| thin | 233 of 1,085 | −0.48 (−0.96 to +0.03) | 29 | 36 | 6% | 9% |

**TIGHTEN_AND_RETRY does not beat the control.** The advisor picks it
whenever the cap is tight, because its predicted cost is marginally lower,
but the realised difference is a wash on deep pairs and slightly negative on
thin ones. On thin pairs it fails a little less often, which does not turn
into a saving. One bias to note: retries are priced on recorded 5→15 s and
15→30 s moves, so the backtest's retry gap is 10–15 s rather than 5 s, which
overstates retry drift and works against this mode.

## Backtest

```bash
npm run backtest                                   # models/cost-model.json, else the example artifact
npm run backtest -- path/to/model.json
npm run backtest -- --until 2026-10-16T14:25:00Z   # fix the data, for a reproducible run
```

This replays the real TypeScript advisor over **held-out** recorded quotes:
orders after the model's training cutoff, one at each recorded rung size.
The orders are hypothetical, but every cost charged to them is read from
recorded quotes: the impact curve of their ladder, the recorded drift path,
and the recorded failures. A fill that misses its cap is completed at the
pair's next recorded ladder, so every strategy ends filled and not trading
never counts as a saving. The advisor is compared with always-SEND_NOW (the
control) and a fixed 4-way split over 30 s, across ρ ∈ [0, 1], with deep and
thin pairs separate.

It runs twice, at a **50 bps cap** and at a **5 bps cap**, and writes
`reports/backtest/README.md`, plus `orders.csv`, `summary.json` and charts
in `reports/backtest/cap-50bps/` and `reports/backtest/cap-5bps/`.

### Results with the example artifact

The committed report was produced with the **example artifact** (the
TypeScript reference fit), not the Colab model, on data up to 2026-10-16
14:25 UTC: 2,177 held-out orders per cap (1,092 deep, 1,085 thin).

**Cap 50 bps.** Saved bps against always-SEND_NOW:

| depth | ρ | mean | median | worse than control | failure rate ctl / advisor / fixed split | fees ctl / advisor | advisor's choices |
|---|---|---|---|---|---|---|---|
| deep | any | 0 | 0 | 0% | 0 / 0 / 0 | $2.18 / $2.18 | SEND_NOW 1,092 |
| thin | 1.0 | 853.8 | 28.0 | 2% (27) | 0 / 0 / 0 | $2.17 / $31.02 | SPLIT 856, SEND_NOW 229 |
| thin | 0.5 | 682.0 | 24.6 | 6% (61) | 0 / 0 / 0 | $2.17 / $34.13 | SPLIT 829, SEND_NOW 256 |
| thin | 0.0 | 0 | 0 | 0% | 0 / 0 / 0 | $2.17 / $2.17 | SEND_NOW 1,085 |

**Cap 5 bps.** Saved bps against always-SEND_NOW:

| depth | ρ | mean | median | worse than control | failure rate ctl / advisor / fixed split | advisor's choices |
|---|---|---|---|---|---|---|
| deep | any | 0.13 | 0 | 15% (166) | 4% / 4% / 5% | TIGHTEN_AND_RETRY 1,092 |
| thin | 1.0 | 853.2 | 27.8 | 6% (68) | 6% / 16% / 9% | SPLIT 852, TIGHTEN_AND_RETRY 233 |
| thin | 0.5 | 681.4 | 24.6 | 9% (101) | 6% / 17% / 9% | SPLIT 829, TIGHTEN_AND_RETRY 256 |
| thin | 0.0 | −0.61 | 0 | 13% (136) | 6% / 5% / 9% | TIGHTEN_AND_RETRY 1,085 |

At 5 bps a split fails more often than one order (16% against 6% on thin
pairs), because each of its k portions is another chance to miss the cap. An
order counts as failed if any portion missed; the missed portions are
completed later, on top of whatever displacement the filled portions left.
The saving survives: the thin median at ρ = 1 is 27.8 bps at 5 bps against
28.0 at 50.

**By size, thin pairs, 50 bps cap:**

| size | control median, bps | saved median at ρ = 1 | breakeven ρ | advisor's choice at ρ = 1 |
|---|---|---|---|---|
| ~$100 | 1.8 | 0 | 0.72 | SEND_NOW 133, SPLIT 22 |
| ~$500 | 7.7 | 5.1 | 0.27 | SPLIT 106, SEND_NOW 49 |
| ~$2k | 15.8 | 11.6 | 0.11 | SPLIT 108, SEND_NOW 47 |
| ~$10k | 44.8 | 33.8 | 0.061 | SPLIT 155 |
| ~$40k | 154.2 | 129.3 | 0.012 | SPLIT 155 |
| ~$200k | 647.9 | 608.7 | 0.003 | SPLIT 155 |
| ~$1M | 2,570.2 | 2,421.0 | 0.001 | SPLIT 155 |

On deep pairs the advisor sends one order at every size. Up to ~$200k that
is right for nearly every order: a split would need ρ of 0.75 or more to pay
for its fees and waiting. At ~$1M it is a **miss**: one order's recorded cost
there has a median of 8.9 bps, so a split would pay for ρ above about 0.35.
The example model predicts only about 3 bps of impact at that size, so the
advisor never sees the saving. That costs nothing against the control, but it
is a saving left on the table, and it comes from the model underpredicting
deep-pair impact at the top of the ladder.

**Low confidence.** 58% of deep recommendations and **100% of thin ones**
are low confidence. The causes differ:

- **Deep pairs:** the gaps are data volume. 262 cells are sparse; 360 are
  fallbacks (no per-pair +5 s cell in the training window, or a default
  volatility); 14 are sizes beyond the sampled range.
- **Thin pairs:** 723 of the 856 SPLIT plans are `extrapolated`, because
  their portions wait longer than the longest measured drift horizon (60 s).
  The rest are fallbacks: the training window ended an hour after thin-pair
  sampling began, so it has no per-pair +5 s cells. More data fixes the
  fallbacks. Only a longer drift horizon in the sampler would fix the
  extrapolation.

## In the app

Before swapping, the dashboard shows an **Execution advice** panel under the
quote:

- the recommended plan, its predicted cost in bps and dollars, and its
  breakdown (impact, drift, fees, chance of missing the cap);
- what sending one order now, splitting and tightening were each predicted
  to cost;
- a low-confidence marker on each prediction that needs one, with the kind
  of gap on hover;
- the live quote's impact beside the model's prediction for the same order,
  since the two can differ (for a ~$30k BONK order at the time of writing:
  187 bps on the live quote, 292 predicted);
- which artifact produced the advice. The example artifact is labelled as
  such.

The panel is advisory. The swap button still sends one order: split
execution is not implemented in the app.

After swapping, the receipt shows quoted against delivered with the
simulated-fill badge, and the settlement log lists each swap's status,
quoted price impact, slippage cap, delivered amount (with its "sim" badge)
and signature.

## Reproducing

**The dataset** is a recording of live mainnet quotes. It can be collected
again but not regenerated: re-running the sampler records a different day.

```bash
docker compose up -d postgres sampler   # the sampler runs until paused
npm run sampler:logs                    # watch it
npm run sampler:pause                   # stop / npm run sampler:resume
npm run export:samples                  # frozen copy: exports/*.csv.gz + manifest
```

`exports/` is gitignored. The export is a faithful dump of both tables: no
filtering, no derived columns, no rows added.

**The fill model:** `npm run build:fill-model` writes
`models/fill-model.json` from the drift rows in the database.

**The cost model** is fitted in Google Colab. Nothing in this repository
needs a local Python install. See `notebooks/README.md`: upload the three
export files to `notebooks/train_cost_model.ipynb`, run all, put the
downloaded `cost-model.json` at `models/cost-model.json`, then:

```bash
npm run validate:model    # schema, self-test vectors, feature-test vectors
```

`npm run fit:example-model` produces `models/cost-model.example.json`, a
TypeScript reference fit of the same contract. The app and the backtest fall
back to it, labelled, when no Colab model is present. `npm run build:notebook`
regenerates the notebook from `scripts/build-notebook.mjs`.

**The backtest:** `npm run backtest -- [model] --until <ISO time>`. The
report prints the exact command that reproduces it.

**Checks:** `npm run typecheck`, `npm run lint`, `npm test`.

## Setup

Requires Docker and Node 22.

```bash
cp .env.example .env
npm install
npm run setup:devnet     # creates the vault and the five mints, prints env values
```

Paste the printed values (five `DEVNET_*_MINT` lines and `VAULT_SECRET_KEY`)
into `.env`, then:

```bash
docker compose up --build
```

The app is on http://localhost:3000. Sign in with the demo credentials from
`.env`, press **Fund from vault**, and swap.

The setup script is safe to re-run. It reuses `.vault.json` and
`.mints.json`, adopts a mint left by an interrupted run, and restocks the
vault to about $5M of each stand-in token. Devnet SOL only comes from the
faucet.

`JUP_API_KEY` is optional; quotes work without it at a lower rate limit. The
sampler uses `SAMPLER_JUP_API_KEY` if set, else shares `JUP_API_KEY` with the
app.

### Running without Docker

```bash
docker compose up -d postgres
npx prisma migrate deploy
npm run dev
```

## Demo path

1. Sign in with the demo account (no OAuth round trip needed). A devnet
   wallet is created on first sign-in. It starts empty.
2. **Fund from vault**: 0.05 devnet SOL from the vault, plus
   `FUND_TOKEN_USD` (default $250,000) worth of each stand-in token, in one
   transaction. Each wallet can be funded once every 10 minutes.
3. Pick a pair and enter an amount. The quote, route and price impact come
   from mainnet, and the advice panel prices the alternatives. To see a
   split recommended, try 10,000,000,000 BONK → USDC (about $30k).
4. **Swap**. The receipt shows quoted against delivered, the simulated-fill
   badge and the signature.
5. Click the signature to open the transaction on Solscan devnet, where both
   transfer instructions are visible inside one transaction.
6. The settlement log keeps every swap with its status, impact, cap and
   explorer link, scoped to the wallet you are looking at.
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

## Limitations

- **Simulated fills.** The payout on devnet is the mainnet quote moved by a
  draw from recorded quote drift. It is a modelled payout, labelled as one
  everywhere, not observed execution. Its horizon comes from measured app
  latency, not from a real on-chain fill.
- **Unmodelled extraction.** MEV (sandwiching, front-running, backrunning)
  was never measured, so it appears nowhere: not in fills, the cost model,
  the advisor or the backtest. Real execution costs are higher by however
  much it takes. It matters most for splits, whose portions are visible and
  predictable on chain.
- **Vault settlement.** The devnet side has no market. The vault pays what
  the server decides, so devnet settlement has no price impact of its own,
  and the read-back proves the transfer, not the price.
- **Devnet stand-in tokens.** USDC, USDT, JUP, BONK and WIF in the app are
  mints this project created on devnet. Their decimals match mainnet and
  they are priced from mainnet quotes, but they have no value and no market.
- **Custodial keys.** Every wallet's private key is generated by the server
  and stored unencrypted in Postgres; the vault key lives in `.vault.json`
  and `.env`. That keeps the demo to one click with no browser wallet. It is
  not a design suitable for real funds.
- **Dataset size.** 13,700 quote samples and 3,439 drift rows, from one day:
  about ten hours of deep-pair data and six of thin. One market regime, no
  weekend, no stress event. Several drift cells are sparse, and the example
  artifact's training window has no thin-pair +5 s cells at all. Every
  number here is conditional on that.
- **Pool recovery ρ is unmeasured.** SPLIT results are a bracket, and the
  shipped advisor assumes ρ = 1 on the regret argument above.
- **Drift is measured to 60 s.** Longer waits (most thin-pair splits) are
  extrapolated, and say so.
- **Naive on-chain execution.** Impact is what one Jupiter-routed AMM swap
  would pay. RFQ, OTC and centralised venues are out of scope.
- **The example artifact.** Until the Colab model is at
  `models/cost-model.json`, the app and the backtest use the TypeScript
  reference fit, labelled as such wherever it is used.
- **Model against live quote.** The cost model's impact for an order can
  differ substantially from the live quote's (the advice panel shows both).
  The plans are compared on the model's figures.
- **Shared Jupiter key.** Without `SAMPLER_JUP_API_KEY`, the sampler and the
  app share one key, and the app's quotes can be rate limited while the
  sampler runs. Pause the sampler for a live demo.
- **Split execution is not implemented.** The advice is advisory; the app
  sends one order.
- The public devnet faucet rate limits. If `setup:devnet` cannot fund the
  vault, fund it manually and re-run.

## Future work

### Measuring pool recovery with an event study

ρ is the advisor's one unmeasured parameter. Every SPLIT figure above is a
bracket because of it, and the regret analysis only decides which edge of
the bracket to assume. It can be measured **without trading and without
capital**, by watching other participants' large swaps and how the pools
recover from them. That keeps mainnet read-only.

**Detect.** Subscribe, read-only, to the thin pools Jupiter routes these
orders through (their accounts are in the recorded routes): `logsSubscribe`
or `accountSubscribe` on a mainnet RPC, or polling recent signatures for the
pool accounts. From each transaction's pre- and post-token balances, find
swaps above a size threshold (say $10k), with their direction, size, slot
and time.

**Probe.** On each event, immediately quote fixed probe sizes through
Jupiter (~$100, and a size near the event's) in both directions, then repeat
at +1, +2, +5, +10, +30, +60, +120 and +300 s. The pre-event baseline comes
from a continuous low-rate probe of the same pool (or the sampler's latest
ladder).

**Estimate.** The displacement D(t) is the probe price's move against the
pre-event baseline. Recovery over an interval Δ is ρ(Δ) = 1 − D(t₀ + Δ) /
D(t₀). Fit a decay with a permanent component,
D(t) = D∞ + (D₀ − D∞)·e^(−t/τ), per pool, by event size and direction. The
advisor needs ρ at its own portion spacing, which runs from 10 s to several
minutes. D∞ / D₀ is the part that never recovers, which is information
being priced in rather than liquidity coming back.

**Control for what is not recovery.**

- *Market moves during the window.* Subtract the token's own price move
  over the same window (Jupiter price v3, or the same token's deepest pool)
  so that only pool-specific displacement remains.
- *Overlapping events.* Drop windows that contain another large swap in the
  same pools.
- *Selection.* Large swaps cluster at particular times; record the times
  and volatility of events alongside the sampler's baseline so the sample
  can be compared.
- *Informed flow.* Someone else's large trade may carry information that
  ours would not, which shows up as a larger permanent component. The
  estimate is therefore conservative for ρ.

Jupiter's quote aggregates across pools, so quoting it measures the
recovery of the route an order would actually take, including arbitrage
refilling one pool from another. That is the quantity the advisor needs.

**What it needs.** A mainnet RPC with websocket subscriptions (read-only); a
dedicated Jupiter key, since each event costs a dozen or more quotes within
a few minutes; and two new tables (events and their probes). No keys, no
signatures, no capital.

**How it plugs in.** ρ becomes a fitted quantity in the cost-model contract
(per pair and portion interval, with its n and a coverage flag like every
other prediction). The advisor reads it instead of a constant, and the
backtest reports at the measured ρ with an interval instead of across a
bracket. The 2×2 above then stops being a decision under ignorance.

The alternative, executing our own swaps on mainnet and watching them
recover, gives cleaner identification but needs capital and mainnet
signing. This project rules that out.

### Other work

- **Longer drift horizons** (+120 s and +300 s re-quotes on a subset of
  ladders), so that split windows are measured rather than extrapolated.
  That is the main reason thin-pair advice stays low confidence.
- **A dedicated sampler key**, so the sampler need not pause for demos and
  the event study has budget.
- **Executing splits in the app**: k devnet settlements over W, each
  re-quoted and capped, with the plan and its outcomes recorded.
- **Anchoring the model to the live quote**: scale the impact curve so it
  matches the live quote at the order's size before pricing the
  alternatives.
- **More data across regimes** (weekends, volatile days), and the Colab model
  re-fitted on it.
- **Measuring extraction** on these pools, so it can enter the cost model as
  a measured term rather than a stated omission.

## Layout

```
app/
  api/quote      mainnet quotes through Jupiter
  api/swap       records the quote, decides the fill, settles on devnet, reads the result back
  api/swaps      settlement history; reconciles Pending swaps against devnet
  api/advice     execution advice for an order, from the cost model (read only)
  api/send       transfers a token out to any devnet address
  api/transfers  outbound transfer history
  api/fund       tops a wallet up from the vault
  api/tokens     devnet balances priced with mainnet prices
  api/wallets    list, create and rename an account's wallets
  lib/swap       the swap flow, with its dependencies injected for tests
  lib/devnet     vault handling, atomic settlement and outbound transfers
  lib/fill*      simulated fills: artifact, draw and runtime inputs
  lib/costModel  cost-model contract: loader, predictions, validation
  lib/advisor    execution-mode advisor
  lib/wallets    wallet creation and the per-request ownership check
  components     interface (SwapPanel, AdvicePanel, TxReceipt, …)
scripts/
  setup-devnet.mjs              creates the vault and the project mints
  sampler/                      the mainnet quote sampler
  export-samples.mjs            dataset export for Colab
  build-fill-model.ts           models/fill-model.json
  cost-model-reference-fit.ts   models/cost-model.example.json
  validate-model.ts             checks a cost-model artifact
  build-notebook.mjs            generates notebooks/train_cost_model.ipynb
  backtest.ts                   reports/backtest/
models/          fill model, cost-model contract and example artifact
notebooks/       the Colab notebook and how to run it
reports/backtest backtest output, both caps
```

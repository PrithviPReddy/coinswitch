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
   MAE 182 vs 1,040 bps, n=1,026). On deep pairs, where impact is a few bps at
   most, the two are about even (1.42 vs 1.57 bps, n=1,057).

   A single power law bends too little at the top of the deep ladder,
   though. It predicted about 3 bps for a $1M SOL order whose recorded impact
   is about 8. So each pair may instead use a **continuous two-segment power
   law**: a hinge in log-log space, with the knot at a rung. Whether a pair
   gets the hinge is decided on its training rows alone, in time order. Both
   models are fitted on the earliest 80% and scored on the latest 20%, and
   the hinge is kept only if it wins there. (Choosing on in-sample BIC
   instead gave hinges to the thin pairs that did worse out of sample.)

   | test MAE, bps | deep (n=1,057) | thin (n=1,026) | deep, $200k and up (n=302) | thin, $200k and up (n=294) |
   |---|---|---|---|---|
   | single power law | 1.42 | 182.5 | 3.02 | 586.8 |
   | **hinge where chosen (the model)** | **0.94** | **139.7** | **1.10** | **442.9** |

   The hinge was chosen for SOL/USDC (knot ~$213k), SOL/USDT and USDC/SOL
   (~$43k), JUP/USDC (~$2k) and WIF/USDC (~$10k). BONK/USDC keeps the single
   line.
2. **Short-horizon drift is not predictable beyond its mean at this data
   scale.** A ridge on horizon and realised volatility does *worse* out of
   sample than predicting the training mean (reference fit: deep MAE 2.97 vs
   2.75 bps, n=235; thin 2.71 vs 2.38 bps, n=228). This is a finding, not a
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
| TIGHTEN_AND_RETRY(c, R) | a tighter cap c, retried up to R times. A fill-reliability mechanism: only offered when it materially cuts the chance of ending unfilled (below) |
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
| **ρ = 1 (shipped)** | **+168.4** (mean +1,489, worst 5% +2.4) | **−0.9** (mean −2.4, worst 5% −74.1) |
| ρ = 0 | 0 (mean 0) | 0 (mean 0) |

At the 5 bps cap the picture is the same: +167.8 against −1.2 (mean −3.1,
worst 5% −76.5), and the ρ = 0 row has a mean of −1.4.

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
| 50 bps | deep | 2 | 0 | 2 | −6.3 | −6.3 | −8 / −5 |
| 50 bps | thin | 162 | 74 | 61 | +1.2 (−7.7 to +6.7) | 0 | −96 / +50 |
| 5 bps | thin | 174 | 78 | 66 | +1.4 (−8.1 to +7.5) | 0 | −97 / +65 |

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

### TIGHTEN_AND_RETRY: a fill-reliability mechanism, not a cost saver

TIGHTEN_AND_RETRY sends the full order with a tighter cap and retries up to
R times. What it can do is make an order less likely to **end unfilled**.
What it cannot do is save money: a rejected attempt does not undo the price
move that rejected it, and the retry starts from the moved price.

So the advisor offers it only when it **materially improves the predicted
chance of filling**. Against one order at the user's cap, its predicted
probability of ending unfilled must fall by at least 1 percentage point and
to at most half (`tightenMinFillGain`, `tightenMaxFailureShare`). Among the
plans that pass, cost decides as usual. Tying or winning on cost is not
enough. Before this gate the advisor chose a 1.25 bps cap with 2 tries for
899 of 1,092 deep orders at a 5 bps cap: a plan predicted to leave the order
unfilled *more* often (8.4% against 2.5%), chosen because its predicted cost
was lower. That cost edge is an artefact. The prediction charges execution
drift only for the attempt that fills, so a tight cap looks as if it dodges
adverse moves. It is why cost alone cannot be the rule, and it means the
predicted cost the app shows for a tightened plan is optimistic.

At a 50 bps cap no fill came near the cap, so TIGHTEN_AND_RETRY is never
offered. The backtest also runs at a **5 bps cap**, where failures happen.
There, with the gate:

| 5 bps cap | chosen | plans | ended unfilled | one order, same orders | mean saved, bps (95% CI) | better / worse than one order |
|---|---|---|---|---|---|---|
| deep | 678 of 1,092 | 2.5 bps × 3 tries (677), 3.75 × 2 (1) | 6 (0.9%) | 24 (3.5%) | −0.03 (−0.57 to +0.52) | 61 / 55 |
| thin | 214 of 1,085 | 1.25 × 3 (152), 2.5 × 2 (61), 3.75 × 2 (1) | 9 (4.2%) | 21 (9.8%) | −0.10 (−1.02 to +0.88) | 29 / 30 |

**It does what it is for: cost-neutral, failure-reducing where it bites.**
Where it is chosen, it cuts orders that end unfilled by about three-quarters
on deep pairs and by more than half on thin ones, and its cost is
indistinguishable from sending one order. Unlike DEFER it stays on.

Three caveats:

- **The gate is only as good as the predicted failure probability.** The 190
  deep orders where the gate kept one order sit in sparse volatility cells
  (n ≈ 20) that predict a 5 bps cap is never missed. In the backtest, 15 of
  them (7.9%) missed it. Those predictions are flagged low confidence.
- **The backtest retries on recorded windows**: 0–5 s, then 5–15 s, then
  15–30 s. Later attempts therefore take 10–15 s rather than 5 s, which
  overstates retry drift and works against this mode. (An earlier version
  interpolated the path, which made the second and third attempts identical
  halves of the 5–15 s move. The first review of this mode, "4.5% → 4.4%
  failures on deep", came from that bug and the ungated plan.)
- **Consecutive recorded windows are close to independent** (correlation
  0.04 deep, −0.03 thin, n ≈ 150 paths each), which is what the advisor's
  p^R assumes.

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
and the recorded failures. Between recorded points it interpolates: impact
linearly in log-notional between a ladder's rungs (for split portions and
completions), and drift linearly between the +5/15/30/60 s re-quotes (for
split portions only). Single orders and retries use recorded points
directly. A fill that misses its cap is completed at the
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
| deep | 1.0 | 0.92 | 0 | 4% (49) | 0 / 0 / 0 | $2.18 / $4.61 | SEND_NOW 853, SPLIT 239 |
| deep | 0.5 | 0.75 | 0 | 3% (38) | 0 / 0 / 0 | $2.18 / $5.39 | SEND_NOW 929, SPLIT 163 |
| deep | 0.0 | 0 | 0 | 0% | 0 / 0 / 0 | $2.18 / $2.18 | SEND_NOW 1,092 |
| thin | 1.0 | 853.8 | 28.0 | 3% (32) | 0 / 0 / 0 | $2.17 / $31.03 | SPLIT 874, SEND_NOW 211 |
| thin | 0.5 | 681.9 | 24.6 | 6% (60) | 0 / 0 / 0 | $2.17 / $33.69 | SPLIT 825, SEND_NOW 260 |
| thin | 0.0 | 0 | 0 | 0% | 0 / 0 / 0 | $2.17 / $2.17 | SEND_NOW 1,085 |

**Cap 5 bps.** Saved bps against always-SEND_NOW:

| depth | ρ | mean | median | worse than control | failure rate ctl / advisor / fixed split | advisor's choices |
|---|---|---|---|---|---|---|
| deep | 1.0 | 0.92 | 0 | 9% (100) | 4.5% / 3.2% / 5% | TIGHTEN_AND_RETRY 678, SPLIT 224, SEND_NOW 190 |
| deep | 0.5 | 0.75 | 0 | 8% (92) | 4% / 3% / 5% | TIGHTEN_AND_RETRY 708, SPLIT 156, SEND_NOW 228 |
| deep | 0.0 | −0.03 | 0 | 6% (67) | 4% / 3% / 5% | TIGHTEN_AND_RETRY 826, SEND_NOW 266 |
| thin | 1.0 | 853.3 | 27.8 | 6% (65) | 6% / 15% / 9% | SPLIT 871, TIGHTEN_AND_RETRY 214 |
| thin | 0.5 | 681.4 | 24.2 | 9% (95) | 6% / 17% / 9% | SPLIT 824, TIGHTEN_AND_RETRY 261 |
| thin | 0.0 | −0.82 | 0 | 13% (136) | 6% / 3% / 9% | TIGHTEN_AND_RETRY 1,085 |

At 5 bps a split fails more often than one order (15% against 6% on thin
pairs), because each of its k portions is another chance to miss the cap. An
order counts as failed if any portion missed; the missed portions are
completed later, on top of whatever displacement the filled portions left.
The saving survives: the thin median at ρ = 1 is 27.8 bps at 5 bps against
28.0 at 50.

**By size, 50 bps cap:**

| depth | size | one order, median bps | saved median at ρ = 1 | breakeven ρ | advisor's choice at ρ = 1 |
|---|---|---|---|---|---|
| deep | ~$100 to ~$40k | 0.4 to 1.0 | 0 | 0.84 or more, or never | SEND_NOW, every order |
| deep | ~$200k | 2.5 | 0 (mean +0.23) | 0.73; never for 132 of 156 | SPLIT 83, SEND_NOW 73 |
| deep | ~$1M | 8.9 | **6.4** | 0.32 | **SPLIT 156** |
| thin | ~$100 | 1.8 | 0 | 0.72 | SEND_NOW 113, SPLIT 42 |
| thin | ~$500 | 7.7 | 5.1 | 0.27 | SPLIT 106, SEND_NOW 49 |
| thin | ~$2k | 15.8 | 10.8 | 0.11 | SPLIT 106, SEND_NOW 49 |
| thin | ~$10k | 44.8 | 33.8 | 0.061 | SPLIT 155 |
| thin | ~$40k | 154.2 | 129.3 | 0.012 | SPLIT 155 |
| thin | ~$200k | 647.9 | 608.7 | 0.003 | SPLIT 155 |
| thin | ~$1M | 2,570.2 | 2,421.0 | 0.001 | SPLIT 155 |

**Deep pairs at ~$1M now get SPLIT.** Under the single power law the model
predicted about 3 bps of impact for these orders, against 8.3 recorded, so the
advisor sent all 156 as one order, although 154 had a finite breakeven ρ
(median 0.35). The piecewise fit predicts 8.8 bps. The advisor now splits all
156: 78 as 4 portions over 30 s, 21 as 6 over 60 s and 57 as 12 over 120 s.

- **At ρ = 1** that saves a median 6.4 bps of the 8.9 one order costs, and
  18 orders come out worse than one order.
- **If the pool never recovers** it costs a mean of 0.25 bps.
- **On SOL/USDC**, the pair the app really trades, recorded impact is
  7.0 bps against 9.3 predicted, and the advisor splits 48 of 48.

At ~$200k the advisor now splits 83 of 156, always as 4 portions over 30 s.
That is a marginal call. It saves +0.4 bps where it splits, comes out worse
than one order in 31 cases, and the recorded curves say a split never pays
for 132 of those 156 orders at any ρ. Below ~$200k it sends one order.

**Low confidence.** 60% of deep recommendations and **100% of thin ones**
are low confidence. The causes differ:

- **Deep pairs:** the gaps are mostly data volume. 233 are sparse and 356
  are fallbacks (no per-pair +5 s cell in the training window, or a default
  volatility). 70 are extrapolated, mostly splits whose portions wait beyond
  60 s.
- **Thin pairs:** 737 of the 874 SPLIT plans are `extrapolated`, because
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
  such;
- "not offered" beside Tighten and retry when it would not make a fill
  materially more likely, with the predicted figures on hover.

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
TypeScript reference fit of the same contract, using the same methods as the
notebook. The committed example was fitted with
`-- --until 2026-10-16T11:28:03.532Z`, the data its first version saw, so
the single-line and piecewise versions compare on identical rows
(`--single-power-law` gives the former). The app and the backtest fall
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
   split recommended on a real pair, try 10,000 SOL → USDC (about $1M):
   4 portions over 30 s, predicted at about 4 bps against 10 bps as one
   order. On a stand-in pair, try 10,000,000,000 BONK → USDC (about $30k).
   (The quote and the advice do not need the balance; the swap does.)
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
- **One knot at most.** The piecewise impact fit allows a single breakpoint,
  at a rung. It is chosen on a validation slice of short training windows
  (about an hour of thin-pair data in the example), so its knots are
  provisional.
- **Naive on-chain execution.** Impact is what one Jupiter-routed AMM swap
  would pay. RFQ, OTC and centralised venues are out of scope.
- **The example artifact.** Until the Colab model is at
  `models/cost-model.json`, the app and the backtest use the TypeScript
  reference fit, labelled as such wherever it is used.
- **Optimistic tightened-plan costs.** The predicted cost of
  TIGHTEN_AND_RETRY charges drift only for the attempt that fills, so it is
  understated. The plan is offered for reliability, not on cost, and the
  backtest prices it on recorded paths, where it comes out cost-neutral.
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

# Backtest: execution-mode advisor on held-out mainnet quotes

- **Artifact:** `cost-20261023T0821Z-33e5b1ec` (colab:notebooks/train_cost_model.ipynb)
- Trained before 2026-10-17T11:00:27.546000+00:00. Held-out orders 2026-10-17T11:03:58.587Z .. 2026-10-23T07:53:30.346Z: **1750 orders per cap**, deep and thin pairs, ~$100 to ~$1M. Data up to 2026-10-23T07:53:50.433Z; reproduce with `npm run backtest -- --until 2026-10-23T07:53:50.433Z`.
- Shipped advisor: DEFER off, fee $0.002/tx, latency 5 s, min 10 s between portions. Control: always SEND_NOW. Fixed baseline: 4 portions over 30 s.
- Realised costs are read from recorded quotes; pool recovery rho is unmeasured and swept over [0, 1].

## Cap 50 bps

### The recovery bracket

| depth | rho | n | mean saved bps | median | p5 | p95 | advisor worse than control | failure rate ctl / adv / fixed | fees $ ctl / adv / fixed | low confidence | advisor modes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | 1.0 | 994 | 1.17 | 0 | 0 | 7.79 | 4% (36) | 0 / 0 / 0 | 1.99 / 5.09 / 7.95 | 60% | SEND_NOW 718, SPLIT 276 |
| deep | 0.5 | 994 | 0.9 | 0 | 0 | 7.23 | 2% (19) | 0 / 0 / 0 | 1.99 / 5.22 / 7.95 | 61% | SEND_NOW 844, SPLIT 150 |
| deep | 0.0 | 994 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.99 / 1.99 / 7.95 | 54% | SEND_NOW 994 |
| thin | 1.0 | 756 | 983 | 29.87 | 0 | 8042.2 | 2% (15) | 0 / 0 / 0 | 1.51 / 22.41 / 6.05 | 83% | SEND_NOW 126, SPLIT 630 |
| thin | 0.5 | 756 | 789.38 | 25.14 | 0 | 5796.64 | 4% (32) | 0 / 0 / 0 | 1.51 / 25.13 / 6.05 | 86% | SEND_NOW 158, SPLIT 598 |
| thin | 0.0 | 756 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.51 / 1.51 / 6.05 | 56% | SEND_NOW 756 |

### Regret: the advisor assumes one rho and the pool has another

Saved bps vs always-SEND_NOW (median, n per row). "assume 1, true 0" is the cost of splitting when the pool never recovers.

| depth | size | n | assume 1, true 1 | assume 1, true 0 | assume 1, true 0 (worst 5%) | assume 0, true 1 | assume 0, true 0 | forgone by assuming 0 | plans differ |
|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$500 | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$2k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$10k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$40k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$200k | 142 | 1.1 | 0 | -3.06 | 0 | 0 | 1.1 | 134 |
| deep | ~$1M | 142 | 6.82 | 0.28 | -5.9 | 0 | 0 | 6.82 | 142 |
| thin | ~$100 | 108 | 0 | 0 | -2.62 | 0 | 0 | 0 | 30 |
| thin | ~$500 | 108 | 5.43 | 0 | -3.53 | 0 | 0 | 5.43 | 84 |
| thin | ~$2k | 108 | 15.2 | 0 | -9.04 | 0 | 0 | 15.2 | 84 |
| thin | ~$10k | 108 | 37.53 | -0.75 | -10.12 | 0 | 0 | 37.53 | 108 |
| thin | ~$40k | 108 | 145.96 | -0.88 | -12.8 | 0 | 0 | 145.96 | 108 |
| thin | ~$200k | 108 | 1374.55 | 0.16 | -59.86 | 0 | 0 | 1374.55 | 108 |
| thin | ~$1M | 108 | 5232.37 | -0.79 | -33.78 | 0 | 0 | 5232.37 | 108 |

The 2x2 for thin pairs, orders of about $10k and up (n=432), saved bps vs always-SEND_NOW, median (mean, worst 5%):

| advisor assumes | pool recovers fully (true rho = 1) | pool never recovers (true rho = 0) |
|---|---|---|
| rho = 1 (shipped) | 201.87 (mean 1715.18, worst 5% 5.77) | -0.71 (mean -0.43, worst 5% -25.94) |
| rho = 0 | 0 (mean 0, worst 5% 0) | 0 (mean 0, worst 5% 0) |

**Asymmetry (thin pairs, orders of about $10k and up, n=432):** assuming full recovery saves a median 201.87 bps (mean 1715.18) when it holds, and costs a median -0.71 bps (mean -0.43, worst 5% -25.94) when the pool never recovers.

### Why plans are low confidence (rho = 1)

Each chosen plan carries the worst coverage among its parts. *sparse*: a cell with fewer than `minConfidentN` observations. *fallback*: borrowed from the pooled depth class, the reversed pair, or a default volatility. *extrapolated*: outside what was measured: a split whose portions wait longer than the longest measured drift horizon (60 s), or an order or portion outside the sampled size range. More data at the same horizons cannot clear the first; only a longer drift horizon in the sampler can.

| depth | chosen mode | n | ok | sparse | fallback | extrapolated | none | low confidence |
|---|---|---|---|---|---|---|---|---|
| deep | SEND_NOW | 718 | 329 | 130 | 252 | 7 | 0 | 0.54 |
| deep | SPLIT | 276 | 65 | 41 | 91 | 79 | 0 | 0.76 |
| thin | SEND_NOW | 126 | 77 | 0 | 49 | 0 | 0 | 0.39 |
| thin | SPLIT | 630 | 48 | 2 | 51 | 529 | 0 | 0.92 |

### Watch: deep pairs at ~$1M

142 orders; 142 have a finite breakeven rho (median 0.246). One order's recorded cost: median 7.91 bps. Impact, recorded 7.87 bps against 7.96 predicted. **The advisor chooses SPLIT for 142 of 142** at rho = 1 (SPLIT 142).

| pair | n | recorded impact median bps | predicted | SPLIT chosen, rho = 1 |
|---|---|---|---|---|
| USDC/SOL | 49 | 7.89 | 7.95 | 49 |
| SOL/USDT | 50 | 8.31 | 8.65 | 50 |
| SOL/USDC | 43 | 6.57 | 6.64 | 43 |

### TIGHTEN_AND_RETRY (offered only when it materially improves predicted fill probability)

| depth | chosen | of orders | median saved bps | mean saved | mean, 95% CI | beat control | worse than control | its failure rate | control failure rate, same orders |
|---|---|---|---|---|---|---|---|---|---|
| deep | 0 | 994 | - | - | - | 0 | 0 | 0 | 0 |
| thin | 0 | 756 | - | - | - | 0 | 0 | 0 | 0 |

### DEFER, switched on as an experiment (off in the shipped advisor)

| depth | deferred | deferring was cheaper | deferring was dearer | mean gain bps | mean, 95% CI | median gain bps | worst | best |
|---|---|---|---|---|---|---|---|---|
| deep | 0 | 0 | 0 | - | - | - | - | - |
| thin | 0 | 0 | 0 | - | - | - | - | - |

### By size

| depth | size | n | control median bps | saved median rho=1 | saved median rho=0 | breakeven rho | split never pays | modes rho=1 | modes rho=0 | choice flips | worse than control | low confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 142 | 0.35 | 0 | 0 | - | 142 | SEND_NOW:142 | SEND_NOW:142 | 0 | 0 | 77 |
| deep | ~$500 | 142 | 0.21 | 0 | 0 | - | 142 | SEND_NOW:142 | SEND_NOW:142 | 0 | 0 | 77 |
| deep | ~$2k | 142 | 0.2 | 0 | 0 | 0.787 | 141 | SEND_NOW:142 | SEND_NOW:142 | 0 | 0 | 77 |
| deep | ~$10k | 142 | 0.38 | 0 | 0 | - | 142 | SEND_NOW:142 | SEND_NOW:142 | 0 | 0 | 77 |
| deep | ~$40k | 142 | 0.8 | 0 | 0 | - | 142 | SEND_NOW:142 | SEND_NOW:142 | 0 | 0 | 77 |
| deep | ~$200k | 142 | 2.08 | 1.1 | 0 | 0.837 | 92 | SPLIT:134 SEND_NOW:8 | SEND_NOW:142 | 134 | 28 | 77 |
| deep | ~$1M | 142 | 7.91 | 6.82 | 0 | 0.246 | 0 | SPLIT:142 | SEND_NOW:142 | 142 | 8 | 138 |
| thin | ~$100 | 108 | 1.67 | 0 | 0 | 0.778 | 78 | SEND_NOW:78 SPLIT:30 | SEND_NOW:108 | 30 | 8 | 61 |
| thin | ~$500 | 108 | 7.87 | 5.43 | 0 | 0.348 | 32 | SEND_NOW:24 SPLIT:84 | SEND_NOW:108 | 84 | 4 | 60 |
| thin | ~$2k | 108 | 20.56 | 15.2 | 0 | 0.131 | 25 | SEND_NOW:24 SPLIT:84 | SEND_NOW:108 | 84 | 2 | 93 |
| thin | ~$10k | 108 | 48.98 | 37.53 | 0 | 0.067 | 2 | SPLIT:108 | SEND_NOW:108 | 108 | 1 | 93 |
| thin | ~$40k | 108 | 169.72 | 145.96 | 0 | 0.011 | 0 | SPLIT:108 | SEND_NOW:108 | 108 | 0 | 108 |
| thin | ~$200k | 108 | 1433.67 | 1374.55 | 0 | 0.002 | 0 | SPLIT:108 | SEND_NOW:108 | 108 | 0 | 108 |
| thin | ~$1M | 108 | 5460.19 | 5232.37 | 0 | 0.001 | 0 | SPLIT:108 | SEND_NOW:108 | 108 | 0 | 108 |

## Cap 5 bps

### The recovery bracket

| depth | rho | n | mean saved bps | median | p5 | p95 | advisor worse than control | failure rate ctl / adv / fixed | fees $ ctl / adv / fixed | low confidence | advisor modes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | 1.0 | 994 | 1.04 | 0 | -0.86 | 7.91 | 7% (69) | 0.02 / 0.04 / 0.05 | 2.03 / 5.16 / 8.05 | 60% | TIGHTEN_AND_RETRY 504, SPLIT 250, SEND_NOW 240 |
| deep | 0.5 | 994 | 0.79 | 0 | -0.64 | 7.15 | 6% (61) | 0.02 / 0.03 / 0.05 | 2.03 / 5.43 / 8.05 | 61% | TIGHTEN_AND_RETRY 564, SPLIT 150, SEND_NOW 280 |
| deep | 0.0 | 994 | -0.12 | 0 | 0 | 0 | 5% (49) | 0.02 / 0.04 / 0.05 | 2.03 / 2.23 / 8.05 | 54% | TIGHTEN_AND_RETRY 658, SEND_NOW 336 |
| thin | 1.0 | 756 | 983.14 | 29.87 | 0 | 8040.63 | 3% (20) | 0.04 / 0.1 / 0.05 | 1.57 / 22.6 / 6.12 | 83% | TIGHTEN_AND_RETRY 98, SPLIT 630, SEND_NOW 28 |
| thin | 0.5 | 756 | 789.56 | 25.16 | -0.05 | 5796.64 | 5% (40) | 0.04 / 0.12 / 0.05 | 1.57 / 25.35 / 6.12 | 86% | TIGHTEN_AND_RETRY 122, SPLIT 597, SEND_NOW 37 |
| thin | 0.0 | 756 | 0.24 | 0 | 0 | 0 | 3% (20) | 0.04 / 0.02 / 0.05 | 1.57 / 1.63 / 6.12 | 56% | TIGHTEN_AND_RETRY 497, SEND_NOW 259 |

### Regret: the advisor assumes one rho and the pool has another

Saved bps vs always-SEND_NOW (median, n per row). "assume 1, true 0" is the cost of splitting when the pool never recovers.

| depth | size | n | assume 1, true 1 | assume 1, true 0 | assume 1, true 0 (worst 5%) | assume 0, true 1 | assume 0, true 0 | forgone by assuming 0 | plans differ |
|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$500 | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$2k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$10k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$40k | 142 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$200k | 142 | 0.58 | 0 | -3.06 | 0 | 0 | 0.58 | 108 |
| deep | ~$1M | 142 | 6.82 | 0.28 | -6.73 | 0 | 0 | 6.82 | 142 |
| thin | ~$100 | 108 | 0 | 0 | -2.63 | 0 | 0 | 0 | 30 |
| thin | ~$500 | 108 | 5.43 | 0 | -3.88 | 0 | 0 | 5.43 | 84 |
| thin | ~$2k | 108 | 15.2 | 0 | -9.04 | 0 | 0 | 15.2 | 84 |
| thin | ~$10k | 108 | 37.53 | -0.79 | -9.13 | 0 | 0 | 37.53 | 108 |
| thin | ~$40k | 108 | 145.96 | -0.88 | -11.96 | 0 | 0 | 145.96 | 108 |
| thin | ~$200k | 108 | 1374.78 | 0.16 | -59.86 | 0 | 0 | 1374.78 | 108 |
| thin | ~$1M | 108 | 5232.37 | -0.87 | -33.78 | 0 | 0 | 5232.37 | 108 |

The 2x2 for thin pairs, orders of about $10k and up (n=432), saved bps vs always-SEND_NOW, median (mean, worst 5%):

| advisor assumes | pool recovers fully (true rho = 1) | pool never recovers (true rho = 0) |
|---|---|---|
| rho = 1 (shipped) | 201.87 (mean 1715.29, worst 5% 5.96) | -0.64 (mean -0.2, worst 5% -25.94) |
| rho = 0 | 0 (mean 0.2, worst 5% 0) | 0 (mean 0.2, worst 5% 0) |

**Asymmetry (thin pairs, orders of about $10k and up, n=432):** assuming full recovery saves a median 201.87 bps (mean 1715.29) when it holds, and costs a median -0.64 bps (mean -0.2, worst 5% -25.94) when the pool never recovers.

### Why plans are low confidence (rho = 1)

Each chosen plan carries the worst coverage among its parts. *sparse*: a cell with fewer than `minConfidentN` observations. *fallback*: borrowed from the pooled depth class, the reversed pair, or a default volatility. *extrapolated*: outside what was measured: a split whose portions wait longer than the longest measured drift horizon (60 s), or an order or portion outside the sampled size range. More data at the same horizons cannot clear the first; only a longer drift horizon in the sampler can.

| depth | chosen mode | n | ok | sparse | fallback | extrapolated | none | low confidence |
|---|---|---|---|---|---|---|---|---|
| deep | TIGHTEN_AND_RETRY | 504 | 219 | 0 | 278 | 7 | 0 | 0.57 |
| deep | SPLIT | 250 | 65 | 41 | 65 | 79 | 0 | 0.74 |
| deep | SEND_NOW | 240 | 110 | 130 | 0 | 0 | 0 | 0.54 |
| thin | TIGHTEN_AND_RETRY | 98 | 49 | 0 | 49 | 0 | 0 | 0.5 |
| thin | SPLIT | 630 | 48 | 2 | 51 | 529 | 0 | 0.92 |
| thin | SEND_NOW | 28 | 28 | 0 | 0 | 0 | 0 | 0 |

### Watch: deep pairs at ~$1M

142 orders; 142 have a finite breakeven rho (median 0.246). One order's recorded cost: median 7.9 bps. Impact, recorded 7.87 bps against 7.96 predicted. **The advisor chooses SPLIT for 142 of 142** at rho = 1 (SPLIT 142).

| pair | n | recorded impact median bps | predicted | SPLIT chosen, rho = 1 |
|---|---|---|---|---|
| USDC/SOL | 49 | 7.89 | 7.95 | 49 |
| SOL/USDT | 50 | 8.31 | 8.65 | 50 |
| SOL/USDC | 43 | 6.57 | 6.64 | 43 |

### TIGHTEN_AND_RETRY (offered only when it materially improves predicted fill probability)

| depth | chosen | of orders | median saved bps | mean saved | mean, 95% CI | beat control | worse than control | its failure rate | control failure rate, same orders |
|---|---|---|---|---|---|---|---|---|---|
| deep | 504 | 994 | 0 | -0.21 | [-0.61, 0.1] (14 blocks) | 10 | 39 | 0.05 | 0.02 |
| thin | 98 | 756 | 0 | 0.5 | [-0.29, 1.8] (16 blocks) | 3 | 6 | 0.01 | 0.04 |

### DEFER, switched on as an experiment (off in the shipped advisor)

| depth | deferred | deferring was cheaper | deferring was dearer | mean gain bps | mean, 95% CI | median gain bps | worst | best |
|---|---|---|---|---|---|---|---|---|
| deep | 0 | 0 | 0 | - | - | - | - | - |
| thin | 0 | 0 | 0 | - | - | - | - | - |

### By size

| depth | size | n | control median bps | saved median rho=1 | saved median rho=0 | breakeven rho | split never pays | modes rho=1 | modes rho=0 | choice flips | worse than control | low confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 142 | 0.35 | 0 | 0 | - | 142 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 0 | 7 | 77 |
| deep | ~$500 | 142 | 0.21 | 0 | 0 | - | 142 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 0 | 7 | 77 |
| deep | ~$2k | 142 | 0.19 | 0 | 0 | 0.787 | 141 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 0 | 7 | 77 |
| deep | ~$10k | 142 | 0.37 | 0 | 0 | - | 142 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 0 | 7 | 77 |
| deep | ~$40k | 142 | 0.8 | 0 | 0 | - | 142 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 0 | 7 | 77 |
| deep | ~$200k | 142 | 2.08 | 0.58 | 0 | 0.837 | 92 | TIGHTEN_AND_RETRY:34 SPLIT:108 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 108 | 26 | 77 |
| deep | ~$1M | 142 | 7.9 | 6.82 | 0 | 0.246 | 0 | SPLIT:142 | TIGHTEN_AND_RETRY:94 SEND_NOW:48 | 142 | 8 | 138 |
| thin | ~$100 | 108 | 1.66 | 0 | 0 | 0.778 | 78 | TIGHTEN_AND_RETRY:50 SEND_NOW:28 SPLIT:30 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 30 | 10 | 61 |
| thin | ~$500 | 108 | 7.84 | 5.43 | 0 | 0.348 | 32 | TIGHTEN_AND_RETRY:24 SPLIT:84 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 84 | 5 | 60 |
| thin | ~$2k | 108 | 20.56 | 15.2 | 0 | 0.131 | 25 | TIGHTEN_AND_RETRY:24 SPLIT:84 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 84 | 4 | 93 |
| thin | ~$10k | 108 | 48.98 | 37.53 | 0 | 0.067 | 2 | SPLIT:108 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 108 | 1 | 93 |
| thin | ~$40k | 108 | 169.72 | 145.96 | 0 | 0.011 | 0 | SPLIT:108 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 108 | 0 | 108 |
| thin | ~$200k | 108 | 1433.67 | 1374.78 | 0 | 0.002 | 0 | SPLIT:108 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 108 | 0 | 108 |
| thin | ~$1M | 108 | 5460.19 | 5232.37 | 0 | 0.001 | 0 | SPLIT:108 | TIGHTEN_AND_RETRY:71 SEND_NOW:37 | 108 | 0 | 108 |

## Limitations

- Recovery rho is unmeasured: the sampler never trades, so no recorded quote reflects our own fills.
- TIGHTEN_AND_RETRY attempts use the drift path's recorded windows (0-5 s, 5-15 s, 15-30 s), so retries take 10-15 s rather than 5 s, which overstates retry drift. A window the path did not record ends the retries (flagged approximate).
- Between recorded points the backtest interpolates: impact linearly in log-notional between a ladder's rungs (for split portions and completions), and drift linearly between the +5/15/30/60 s re-quotes (for split portions). Retries and single orders use recorded points only.
- Drift beyond 60 s uses ladder-to-ladder rung-1 price changes, ladders every 90-120 s: coarse.
- Orders are synthetic (one per recorded rung size on ladders with a recorded +5 s re-quote); every realised cost is read from recorded quotes.
- A failed fill is completed at the pair's next recorded ladder (1-10 min later), paying the recorded waiting drift and that ladder's impact, so every strategy ends filled. Failed split portions are completed on top of the displacement our filled portions left, decayed one further rho step (exact at rho = 0 and 1, conservative between). Failure rates are reported separately.
- Impact is naive on-chain execution through Jupiter's AMM routing.
- Confidence intervals are block bootstraps (30-minute blocks of order time, 5000 resamples): orders close in time share a market. Few blocks make for wide, approximate intervals.

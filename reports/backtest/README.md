# Backtest: execution-mode advisor on held-out mainnet quotes

- **Artifact:** `example-cost-20261016T1128Z-c1df57e7` (ts-reference-fit (example only)) — **EXAMPLE ARTIFACT, not the Colab model; re-run for the headline**
- Trained before 2026-10-16T09:24:55.093Z. Held-out orders 2026-10-16T09:26:35.070Z .. 2026-10-16T14:24:15.130Z: **2177 orders per cap**, deep and thin pairs, ~$100 to ~$1M. Data up to 2026-10-16T14:25:00.000Z; reproduce with `npm run backtest -- models/cost-model.example.json --until 2026-10-16T14:25:00.000Z`.
- Shipped advisor: DEFER off, fee $0.002/tx, latency 5 s, min 10 s between portions. Control: always SEND_NOW. Fixed baseline: 4 portions over 30 s.
- Realised costs are read from recorded quotes; pool recovery rho is unmeasured and swept over [0, 1].

## Cap 50 bps

### The recovery bracket

| depth | rho | n | mean saved bps | median | p5 | p95 | advisor worse than control | failure rate ctl / adv / fixed | fees $ ctl / adv / fixed | low confidence | advisor modes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | 1.0 | 1092 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 2.18 / 2.18 / 8.74 | 58% | SEND_NOW 1092 |
| deep | 0.5 | 1092 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 2.18 / 2.18 / 8.74 | 58% | SEND_NOW 1092 |
| deep | 0.0 | 1092 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 2.18 / 2.18 / 8.74 | 58% | SEND_NOW 1092 |
| thin | 1.0 | 1085 | 853.82 | 28.02 | 0 | 8072.47 | 2% (27) | 0 / 0 / 0 | 2.17 / 31.02 / 8.68 | 100% | SEND_NOW 229, SPLIT 856 |
| thin | 0.5 | 1085 | 681.95 | 24.62 | -0.41 | 5614.59 | 6% (61) | 0 / 0 / 0 | 2.17 / 34.13 / 8.68 | 100% | SEND_NOW 256, SPLIT 829 |
| thin | 0.0 | 1085 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 2.17 / 2.17 / 8.68 | 100% | SEND_NOW 1085 |

### Regret: the advisor assumes one rho and the pool has another

Saved bps vs always-SEND_NOW (median, n per row). "assume 1, true 0" is the cost of splitting when the pool never recovers.

| depth | size | n | assume 1, true 1 | assume 1, true 0 | assume 1, true 0 (worst 5%) | assume 0, true 1 | assume 0, true 0 | forgone by assuming 0 | plans differ |
|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$500 | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$2k | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$10k | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$40k | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$200k | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | ~$1M | 156 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| thin | ~$100 | 155 | 0 | 0 | -0.9 | 0 | 0 | 0 | 22 |
| thin | ~$500 | 155 | 5.14 | 0 | -5.85 | 0 | 0 | 5.14 | 106 |
| thin | ~$2k | 155 | 11.57 | 0 | -11.23 | 0 | 0 | 11.57 | 108 |
| thin | ~$10k | 155 | 33.83 | -0.49 | -14.35 | 0 | 0 | 33.83 | 155 |
| thin | ~$40k | 155 | 129.28 | -0.68 | -20.56 | 0 | 0 | 129.28 | 155 |
| thin | ~$200k | 155 | 608.71 | -0.43 | -109.99 | 0 | 0 | 608.71 | 155 |
| thin | ~$1M | 155 | 2420.99 | -2.87 | -108.67 | 0 | 0 | 2420.99 | 155 |

The 2x2 for thin pairs, orders of about $10k and up (n=620), saved bps vs always-SEND_NOW, median (mean, worst 5%):

| advisor assumes | pool recovers fully (true rho = 1) | pool never recovers (true rho = 0) |
|---|---|---|
| rho = 1 (shipped) | 168.44 (mean 1489.37, worst 5% 2.35) | -0.98 (mean -2.4, worst 5% -74.14) |
| rho = 0 | 0 (mean 0, worst 5% 0) | 0 (mean 0, worst 5% 0) |

**Asymmetry (thin pairs, orders of about $10k and up, n=620):** assuming full recovery saves a median 168.44 bps (mean 1489.37) when it holds, and costs a median -0.98 bps (mean -2.4, worst 5% -74.14) when the pool never recovers.

### Why plans are low confidence (rho = 1)

Each chosen plan carries the worst coverage among its parts. *sparse*: a cell with fewer than `minConfidentN` observations. *fallback*: borrowed from the pooled depth class, the reversed pair, or a default volatility. *extrapolated*: outside what was measured: a split whose portions wait longer than the longest measured drift horizon (60 s), or an order or portion outside the sampled size range. More data at the same horizons cannot clear the first; only a longer drift horizon in the sampler can.

| depth | chosen mode | n | ok | sparse | fallback | extrapolated | none | low confidence |
|---|---|---|---|---|---|---|---|---|
| deep | SEND_NOW | 1092 | 456 | 262 | 360 | 14 | 0 | 0.58 |
| thin | SEND_NOW | 229 | 0 | 0 | 229 | 0 | 0 | 1 |
| thin | SPLIT | 856 | 0 | 0 | 133 | 723 | 0 | 1 |

### TIGHTEN_AND_RETRY

| depth | chosen | of orders | median saved bps | mean saved | mean, 95% CI | beat control | worse than control | its failure rate | control failure rate, same orders |
|---|---|---|---|---|---|---|---|---|---|
| deep | 0 | 1092 | - | - | - | 0 | 0 | 0 | 0 |
| thin | 0 | 1085 | - | - | - | 0 | 0 | 0 | 0 |

### DEFER, switched on as an experiment (off in the shipped advisor)

| depth | deferred | deferring was cheaper | deferring was dearer | mean gain bps | mean, 95% CI | median gain bps | worst | best |
|---|---|---|---|---|---|---|---|---|
| deep | 0 | 0 | 0 | - | - | - | - | - |
| thin | 161 | 74 | 61 | 1.38 | [-7.66, 7.07] (8 blocks) | 0 | -96.23 | 50.11 |

### By size

| depth | size | n | control median bps | saved median rho=1 | saved median rho=0 | breakeven rho | split never pays | modes rho=1 | modes rho=0 | choice flips | worse than control | low confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 156 | 0.55 | 0 | 0 | - | 156 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 91 |
| deep | ~$500 | 156 | 0.43 | 0 | 0 | - | 156 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 90 |
| deep | ~$2k | 156 | 0.52 | 0 | 0 | 0.983 | 155 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 90 |
| deep | ~$10k | 156 | 0.72 | 0 | 0 | 0.842 | 155 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 90 |
| deep | ~$40k | 156 | 1.04 | 0 | 0 | - | 156 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 90 |
| deep | ~$200k | 156 | 2.49 | 0 | 0 | 0.747 | 128 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 90 |
| deep | ~$1M | 156 | 8.88 | 0 | 0 | 0.348 | 2 | SEND_NOW:156 | SEND_NOW:156 | 0 | 0 | 95 |
| thin | ~$100 | 155 | 1.78 | 0 | 0 | 0.716 | 109 | SEND_NOW:133 SPLIT:22 | SEND_NOW:155 | 22 | 2 | 155 |
| thin | ~$500 | 155 | 7.71 | 5.14 | 0 | 0.272 | 59 | SEND_NOW:49 SPLIT:106 | SEND_NOW:155 | 106 | 4 | 155 |
| thin | ~$2k | 155 | 15.8 | 11.57 | 0 | 0.105 | 54 | SEND_NOW:47 SPLIT:108 | SEND_NOW:155 | 108 | 5 | 155 |
| thin | ~$10k | 155 | 44.76 | 33.83 | 0 | 0.061 | 1 | SPLIT:155 | SEND_NOW:155 | 155 | 11 | 155 |
| thin | ~$40k | 155 | 154.24 | 129.28 | 0 | 0.012 | 1 | SPLIT:155 | SEND_NOW:155 | 155 | 5 | 155 |
| thin | ~$200k | 155 | 647.88 | 608.71 | 0 | 0.003 | 0 | SPLIT:155 | SEND_NOW:155 | 155 | 0 | 155 |
| thin | ~$1M | 155 | 2570.22 | 2420.99 | 0 | 0.001 | 0 | SPLIT:155 | SEND_NOW:155 | 155 | 0 | 155 |

## Cap 5 bps

### The recovery bracket

| depth | rho | n | mean saved bps | median | p5 | p95 | advisor worse than control | failure rate ctl / adv / fixed | fees $ ctl / adv / fixed | low confidence | advisor modes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | 1.0 | 1092 | 0.13 | 0 | -0.82 | 2.01 | 15% (166) | 0.04 / 0.04 / 0.05 | 2.28 / 2.94 / 8.85 | 58% | TIGHTEN_AND_RETRY 1092 |
| deep | 0.5 | 1092 | 0.13 | 0 | -0.82 | 2.01 | 15% (166) | 0.04 / 0.04 / 0.05 | 2.28 / 2.94 / 8.85 | 58% | TIGHTEN_AND_RETRY 1092 |
| deep | 0.0 | 1092 | 0.13 | 0 | -0.82 | 2.01 | 15% (166) | 0.04 / 0.04 / 0.05 | 2.28 / 2.94 / 8.85 | 58% | TIGHTEN_AND_RETRY 1092 |
| thin | 1.0 | 1085 | 853.2 | 27.83 | -0.2 | 8071.84 | 6% (68) | 0.06 / 0.16 / 0.09 | 2.3 / 31.48 / 8.88 | 100% | TIGHTEN_AND_RETRY 233, SPLIT 852 |
| thin | 0.5 | 1085 | 681.41 | 24.61 | -1.95 | 5614.59 | 9% (101) | 0.06 / 0.17 / 0.09 | 2.3 / 34.65 / 8.88 | 100% | TIGHTEN_AND_RETRY 256, SPLIT 829 |
| thin | 0.0 | 1085 | -0.61 | 0 | -2.38 | 1.75 | 13% (136) | 0.06 / 0.05 / 0.09 | 2.3 / 2.89 / 8.88 | 100% | TIGHTEN_AND_RETRY 1085 |

### Regret: the advisor assumes one rho and the pool has another

Saved bps vs always-SEND_NOW (median, n per row). "assume 1, true 0" is the cost of splitting when the pool never recovers.

| depth | size | n | assume 1, true 1 | assume 1, true 0 | assume 1, true 0 (worst 5%) | assume 0, true 1 | assume 0, true 0 | forgone by assuming 0 | plans differ |
|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 156 | 0 | 0 | -1.05 | 0 | 0 | 0 | 0 |
| deep | ~$500 | 156 | 0 | 0 | -0.83 | 0 | 0 | 0 | 0 |
| deep | ~$2k | 156 | 0 | 0 | -0.81 | 0 | 0 | 0 | 0 |
| deep | ~$10k | 156 | 0 | 0 | -0.79 | 0 | 0 | 0 | 0 |
| deep | ~$40k | 156 | 0 | 0 | -0.79 | 0 | 0 | 0 | 0 |
| deep | ~$200k | 156 | 0 | 0 | -0.79 | 0 | 0 | 0 | 0 |
| deep | ~$1M | 156 | 0 | 0 | -0.79 | 0 | 0 | 0 | 0 |
| thin | ~$100 | 155 | 0 | 0 | -3.68 | 0 | 0 | 0 | 20 |
| thin | ~$500 | 155 | 4.54 | 0 | -8.06 | 0 | 0 | 4.54 | 106 |
| thin | ~$2k | 155 | 11.32 | 0 | -11.71 | 0 | 0 | 11.32 | 106 |
| thin | ~$10k | 155 | 33.83 | -0.83 | -16.51 | 0 | 0 | 33.83 | 155 |
| thin | ~$40k | 155 | 129.28 | -0.68 | -20.96 | 0 | 0 | 129.28 | 155 |
| thin | ~$200k | 155 | 608.71 | -1.59 | -113.07 | 0 | 0 | 608.71 | 155 |
| thin | ~$1M | 155 | 2420.99 | -3.28 | -104.11 | 0 | 0 | 2420.99 | 155 |

The 2x2 for thin pairs, orders of about $10k and up (n=620), saved bps vs always-SEND_NOW, median (mean, worst 5%):

| advisor assumes | pool recovers fully (true rho = 1) | pool never recovers (true rho = 0) |
|---|---|---|
| rho = 1 (shipped) | 167.83 (mean 1488.59, worst 5% 2.35) | -1.21 (mean -3.15, worst 5% -76.5) |
| rho = 0 | 0 (mean -0.82, worst 5% -2.38) | 0 (mean -0.82, worst 5% -2.38) |

**Asymmetry (thin pairs, orders of about $10k and up, n=620):** assuming full recovery saves a median 167.83 bps (mean 1488.59) when it holds, and costs a median -1.21 bps (mean -3.15, worst 5% -76.5) when the pool never recovers.

### Why plans are low confidence (rho = 1)

Each chosen plan carries the worst coverage among its parts. *sparse*: a cell with fewer than `minConfidentN` observations. *fallback*: borrowed from the pooled depth class, the reversed pair, or a default volatility. *extrapolated*: outside what was measured: a split whose portions wait longer than the longest measured drift horizon (60 s), or an order or portion outside the sampled size range. More data at the same horizons cannot clear the first; only a longer drift horizon in the sampler can.

| depth | chosen mode | n | ok | sparse | fallback | extrapolated | none | low confidence |
|---|---|---|---|---|---|---|---|---|
| deep | TIGHTEN_AND_RETRY | 1092 | 456 | 262 | 360 | 14 | 0 | 0.58 |
| thin | TIGHTEN_AND_RETRY | 233 | 0 | 0 | 233 | 0 | 0 | 1 |
| thin | SPLIT | 852 | 0 | 0 | 131 | 721 | 0 | 1 |

### TIGHTEN_AND_RETRY

| depth | chosen | of orders | median saved bps | mean saved | mean, 95% CI | beat control | worse than control | its failure rate | control failure rate, same orders |
|---|---|---|---|---|---|---|---|---|---|
| deep | 1092 | 1092 | 0 | 0.13 | [-0.35, 0.49] (9 blocks) | 162 | 166 | 0.04 | 0.04 |
| thin | 233 | 1085 | 0 | -0.48 | [-0.96, 0.03] (11 blocks) | 29 | 36 | 0.06 | 0.09 |

### DEFER, switched on as an experiment (off in the shipped advisor)

| depth | deferred | deferring was cheaper | deferring was dearer | mean gain bps | mean, 95% CI | median gain bps | worst | best |
|---|---|---|---|---|---|---|---|---|
| deep | 0 | 0 | 0 | - | - | - | - | - |
| thin | 172 | 77 | 66 | 1.38 | [-8.1, 7.58] (8 blocks) | 0 | -96.52 | 64.66 |

### By size

| depth | size | n | control median bps | saved median rho=1 | saved median rho=0 | breakeven rho | split never pays | modes rho=1 | modes rho=0 | choice flips | worse than control | low confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 156 | 0.55 | 0 | 0 | - | 156 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 26 | 91 |
| deep | ~$500 | 156 | 0.43 | 0 | 0 | - | 156 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 24 | 90 |
| deep | ~$2k | 156 | 0.52 | 0 | 0 | 0.983 | 155 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 24 | 90 |
| deep | ~$10k | 156 | 0.72 | 0 | 0 | 0.842 | 155 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 24 | 90 |
| deep | ~$40k | 156 | 1.04 | 0 | 0 | - | 156 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 23 | 90 |
| deep | ~$200k | 156 | 2.49 | 0 | 0 | 0.747 | 128 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 23 | 90 |
| deep | ~$1M | 156 | 8.88 | 0 | 0 | 0.348 | 2 | TIGHTEN_AND_RETRY:156 | TIGHTEN_AND_RETRY:156 | 0 | 22 | 95 |
| thin | ~$100 | 155 | 1.56 | 0 | 0 | 0.716 | 109 | TIGHTEN_AND_RETRY:135 SPLIT:20 | TIGHTEN_AND_RETRY:155 | 20 | 19 | 155 |
| thin | ~$500 | 155 | 7.59 | 4.54 | 0 | 0.272 | 59 | TIGHTEN_AND_RETRY:49 SPLIT:106 | TIGHTEN_AND_RETRY:155 | 106 | 15 | 155 |
| thin | ~$2k | 155 | 16.82 | 11.32 | 0 | 0.105 | 54 | TIGHTEN_AND_RETRY:49 SPLIT:106 | TIGHTEN_AND_RETRY:155 | 106 | 14 | 155 |
| thin | ~$10k | 155 | 44.76 | 33.83 | 0 | 0.061 | 1 | SPLIT:155 | TIGHTEN_AND_RETRY:155 | 155 | 15 | 155 |
| thin | ~$40k | 155 | 154.24 | 129.28 | 0 | 0.012 | 1 | SPLIT:155 | TIGHTEN_AND_RETRY:155 | 155 | 5 | 155 |
| thin | ~$200k | 155 | 647.88 | 608.71 | 0 | 0.003 | 0 | SPLIT:155 | TIGHTEN_AND_RETRY:155 | 155 | 0 | 155 |
| thin | ~$1M | 155 | 2570.22 | 2420.99 | 0 | 0.001 | 0 | SPLIT:155 | TIGHTEN_AND_RETRY:155 | 155 | 0 | 155 |

## Limitations

- Recovery rho is unmeasured: the sampler never trades, so no recorded quote reflects our own fills.
- TIGHTEN_AND_RETRY retries are priced on recorded 5->15 s and 15->30 s moves: retry gaps of 10-15 s rather than 5 s, overstating retry drift.
- Drift beyond 60 s uses ladder-to-ladder rung-1 price changes, ladders every 90-120 s: coarse.
- Orders are synthetic (one per recorded rung size on ladders with a recorded +5 s re-quote); every realised cost is read from recorded quotes.
- A failed fill is completed at the pair's next recorded ladder (1-10 min later), paying the recorded waiting drift and that ladder's impact, so every strategy ends filled. Failed split portions are completed on top of the displacement our filled portions left, decayed one further rho step (exact at rho = 0 and 1, conservative between). Failure rates are reported separately.
- Impact is naive on-chain execution through Jupiter's AMM routing.
- Confidence intervals are block bootstraps (30-minute blocks of order time, 5000 resamples): orders close in time share a market. Few blocks make for wide, approximate intervals.
- **Produced with the EXAMPLE artifact** (TypeScript reference fit), not the Colab cost model.

# Backtest: execution-mode advisor on held-out mainnet quotes

- Artifact: `example-cost-20261016T1128Z-c1df57e7` (ts-reference-fit (example only)) — **EXAMPLE ARTIFACT, not the Colab model**
- Trained before 2026-10-16T09:24:55.093Z; held-out orders 2026-10-16T09:26:35.070Z .. 2026-10-16T13:46:35.150Z: **1855 orders** from 265 ladders
- Cap 50 bps, fee $0.002/tx, latency 5 s; control = always SEND_NOW; fixed baseline = split 4 over 30 s

## The recovery bracket (pool recovery rho is unmeasured)

| depth | rho | n | mean saved | median saved | p5 | p95 | advisor worse than control | failure (ctl / adv / fixed) | fees $ (ctl / adv / fixed) | low confidence | modes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | 1.0 | 924 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.85 / 1.85 / 7.39 | 62% | SEND_NOW 924 |
| deep | 0.5 | 924 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.85 / 1.85 / 7.39 | 62% | SEND_NOW 924 |
| deep | 0.0 | 924 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.85 / 1.85 / 7.39 | 62% | SEND_NOW 924 |
| thin | 1.0 | 931 | 845.55 | 28.32 | 0 | 8097.37 | 3% (27) | 0 / 0 / 0 | 1.86 / 26.73 / 7.45 | 100% | SEND_NOW 193, SPLIT 643, DEFER 95 |
| thin | 0.5 | 931 | 675.85 | 24.87 | -0.63 | 5608.52 | 6% (54) | 0 / 0 / 0 | 1.86 / 29.61 / 7.45 | 100% | SEND_NOW 217, SPLIT 614, DEFER 100 |
| thin | 0.0 | 931 | 0 | 0 | 0 | 0 | 0% (0) | 0 / 0 / 0 | 1.86 / 1.86 / 7.45 | 100% | SEND_NOW 931 |

## Does DEFER help? Deferred plan vs the same plan executed at once

| depth | rho | deferred orders | deferring was cheaper | mean gain bps | median gain bps |
|---|---|---|---|---|---|
| deep | 1.0 | 0 | 0 | - | - |
| deep | 0.5 | 0 | 0 | - | - |
| deep | 0.0 | 0 | 0 | - | - |
| thin | 1.0 | 95 | 41 | -0.77 | 0 |
| thin | 0.5 | 100 | 40 | -2.23 | 0 |
| thin | 0.0 | 0 | 0 | - | - |

## By size: savings at both bounds, breakeven recovery, and whether the choice flips

| depth | size | n | control median bps | saved median (rho=1) | saved median (rho=0) | breakeven rho (median) | split never pays | modes at rho=1 | modes at rho=0 | choice flips | worse than control (rho=1) | low confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deep | ~$100 | 132 | 0.64 | 0 | 0 | - | 132 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$500 | 132 | 0.51 | 0 | 0 | - | 132 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$2k | 132 | 0.69 | 0 | 0 | 0.983 | 131 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$10k | 132 | 0.85 | 0 | 0 | 0.842 | 131 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$40k | 132 | 1.11 | 0 | 0 | - | 132 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$200k | 132 | 2.52 | 0 | 0 | 0.732 | 106 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 81 |
| deep | ~$1M | 132 | 9.07 | 0 | 0 | 0.345 | 0 | SEND_NOW:132 | SEND_NOW:132 | 0 | 0 | 86 |
| thin | ~$100 | 133 | 1.78 | 0 | 0 | 0.716 | 88 | SEND_NOW:111 SPLIT:22 | SEND_NOW:133 | 22 | 2 | 133 |
| thin | ~$500 | 133 | 7.71 | 4.78 | 0 | 0.254 | 50 | SEND_NOW:42 SPLIT:90 DEFER:1 | SEND_NOW:133 | 91 | 4 | 133 |
| thin | ~$2k | 133 | 14.46 | 10.15 | 0 | 0.107 | 45 | SEND_NOW:40 SPLIT:92 DEFER:1 | SEND_NOW:133 | 93 | 5 | 133 |
| thin | ~$10k | 133 | 44.76 | 33.1 | 0 | 0.061 | 0 | SPLIT:119 DEFER:14 | SEND_NOW:133 | 133 | 8 | 133 |
| thin | ~$40k | 133 | 156.72 | 123.08 | 0 | 0.012 | 0 | SPLIT:110 DEFER:23 | SEND_NOW:133 | 133 | 8 | 133 |
| thin | ~$200k | 133 | 647.39 | 606.9 | 0 | 0.003 | 0 | SPLIT:105 DEFER:28 | SEND_NOW:133 | 133 | 0 | 133 |
| thin | ~$1M | 133 | 2570.76 | 2417.17 | 0 | 0.001 | 0 | SPLIT:105 DEFER:28 | SEND_NOW:133 | 133 | 0 | 133 |

## Limitations

- Recovery rho is unmeasured: the sampler never trades, so no recorded quote reflects our own fills. Results are bracketed over rho in [0, 1].
- TIGHTEN_AND_RETRY retries are priced on recorded 5->15 s and 15->30 s moves: retry gaps of 10-15 s rather than 5 s, overstating retry drift.
- Drift beyond 60 s uses ladder-to-ladder rung-1 price changes, ladders every 90-120 s: coarse.
- Orders are synthetic (one per recorded rung size on ladders with a recorded +5 s re-quote); all realised costs are read from recorded quotes.
- Impact is naive on-chain execution through Jupiter's AMM routing.
- PRODUCED WITH THE EXAMPLE ARTIFACT (TypeScript reference fit), not the Colab cost model. Re-run with models/cost-model.json for the headline result.

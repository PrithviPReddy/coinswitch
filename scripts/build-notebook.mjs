/**
 * Generates notebooks/train_cost_model.ipynb from the cells below.
 *
 *   npm run build:notebook
 *
 * The notebook runs in Google Colab only; nothing here executes Python. Its
 * code mirrors scripts/cost-model-reference-fit.ts and app/lib/costModel.ts
 * line for line where the contract (models/cost-model.schema.json) requires
 * identical arithmetic, so `npm run validate:model` can hold the two to it.
 */

import fs from "node:fs";

const md = (text) => ({ cell_type: "markdown", metadata: {}, source: text.trim() + "\n" });
const code = (text) => ({ cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: text.trim() + "\n" });

const cells = [
  md(String.raw`
# CoinSwitch cost model

Fits the three targets of the cost model from the mainnet quote dataset the CoinSwitch sampler recorded, and writes 'cost-model.json' in the format of 'models/cost-model.schema.json'.

| Target | Model | Data |
|---|---|---|
| (a) price impact, bps, by pair and size | power law per pair (OLS in log space); ridge baseline | QuoteSample ladders |
| (b) expected adverse drift over horizon T, bps | ridge on [sqrt T, volatility x sqrt(T/60), thin x sqrt T]; train-mean baseline | QuoteDrift |
| (c) P(drift over T exceeds the cap) | empirical exceedance from 101-point quantiles | QuoteDrift |

**Run: Runtime > Run all.** Cell 1 asks for three files from 'npm run export:samples': 'quote_samples.csv.gz', 'quote_drift.csv.gz' and 'export_manifest.json'. At the end the notebook downloads 'cost-model.json' plus a zip of figures and report tables, and prints a plain-text summary to paste back.

Rules this notebook keeps: the train/test split is **by time, never random**. **Deep and thin pairs are reported separately**, never pooled. **Every metric carries its n**. The model is fitted on the training period only, so the held-out period stays clean for the backtest.

Only libraries Colab ships are used: pandas, numpy, scikit-learn and matplotlib. CPU runtime.
`),

  code(String.raw`
# 1. Data: upload, or read from Google Drive.
import os, io, json, math, bisect, hashlib, shutil, datetime as dt
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from sklearn.linear_model import Ridge

USE_DRIVE = False                     # True: read the three files from DRIVE_DIR instead of uploading
DRIVE_DIR = "/content/drive/MyDrive/coinswitch"
REQUIRED = {"quote_samples": "quote_samples.csv.gz", "quote_drift": "quote_drift.csv.gz", "export_manifest": "export_manifest.json"}

try:
    from google.colab import files as colab_files
    IN_COLAB = True
except ImportError:
    colab_files = None
    IN_COLAB = False

if USE_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    DATA_DIR = DRIVE_DIR
else:
    DATA_DIR = "/content/coinswitch_data" if IN_COLAB else "coinswitch_data"
os.makedirs(DATA_DIR, exist_ok=True)

def missing_files():
    return [f for f in REQUIRED.values() if not os.path.exists(os.path.join(DATA_DIR, f))]

if missing_files() and IN_COLAB and not USE_DRIVE:
    print("Upload these files from 'npm run export:samples':", ", ".join(missing_files()))
    uploaded = colab_files.upload()
    for name, content in uploaded.items():
        # Colab renames repeat uploads to e.g. "quote_drift (1).csv.gz".
        for stem, target in REQUIRED.items():
            if os.path.basename(name).startswith(stem):
                with open(os.path.join(DATA_DIR, target), "wb") as fh:
                    fh.write(content)

if missing_files():
    raise FileNotFoundError("Still missing: " + ", ".join(missing_files()) + " in " + DATA_DIR)

OUT_DIR = "/content/coinswitch_out" if IN_COLAB else "coinswitch_out"
os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(DATA_DIR, REQUIRED["export_manifest"])) as fh:
    MANIFEST = json.load(fh)
print("Export made", MANIFEST["exportedAt"], "with", MANIFEST["rowCounts"])
`),

  code(String.raw`
# 2. Load and type the raw columns. Features are derived below, in one place.
EPOCH = pd.Timestamp("1970-01-01", tz="UTC")

def to_ms(series):
    return ((pd.to_datetime(series, utc=True) - EPOCH) // pd.Timedelta(milliseconds=1)).astype("int64")

samples = pd.read_csv(os.path.join(DATA_DIR, REQUIRED["quote_samples"]), compression="gzip")
drift_raw = pd.read_csv(os.path.join(DATA_DIR, REQUIRED["quote_drift"]), compression="gzip")

samples["t"] = to_ms(samples["sampledAt"])
for col in ["notionalUsd", "measuredImpactBps", "effectivePrice"]:
    samples[col] = pd.to_numeric(samples[col], errors="coerce")
samples["ladderRung"] = samples["ladderRung"].astype(int)

drift_raw["requotedT"] = to_ms(drift_raw["requotedAt"])
for col in ["driftBps", "actualElapsedMs"]:
    drift_raw[col] = pd.to_numeric(drift_raw[col], errors="coerce")

THIN = {"JUP", "BONK", "WIF"}
def depth_of(pair):
    return "thin" if any(s in THIN for s in str(pair).split("/")) else "deep"

origins = samples[["id", "pair", "t", "notionalUsd", "ladderRung"]].rename(columns={"id": "originSampleId"})
drift = drift_raw.merge(origins, on="originSampleId", how="inner")
samples["depth"] = samples["pair"].map(depth_of)
drift["depth"] = drift["pair"].map(depth_of)

PAIRS = sorted(samples["pair"].unique().tolist())
print(f"QuoteSample rows: {len(samples):,}   QuoteDrift rows: {len(drift_raw):,} ({len(drift):,} joined to an origin)")
print("Pairs:", ", ".join(f"{p} ({depth_of(p)})" for p in PAIRS))
print("Time range:", samples["sampledAt"].min(), "..", samples["sampledAt"].max())
`),

  code(String.raw`
# 3. Contract constants (models/cost-model.schema.json) and collection phases.
HORIZONS = [5, 15, 30, 60]
IMPACT_FLOOR_BPS = 0.5
MAX_LADDER_SPAN_S = 30
MIN_CELL_N = 20
MIN_CONFIDENT_N = 30
BASELINE_NOTIONAL_USD = 25
RIDGE_ALPHA = 1.0
TRAIN_FRACTION = 0.7
VOL = {"windowMinutes": 30, "rung": 1, "minReturns": 8, "maxGapSeconds": 600, "unit": "bps per sqrt(minute)"}

def parse_ms(iso):
    return int((pd.Timestamp(iso) - EPOCH) // pd.Timedelta(milliseconds=1))

V2_START = parse_ms(MANIFEST["collectionPhases"]["v2Start"])
LIMITER_FIX = parse_ms(MANIFEST["collectionPhases"]["limiterKeylessPriceFix"])

def phase_of(t):
    if t < V2_START:
        return "1 v1"
    return "2 v2 before limiter fix" if t < LIMITER_FIX else "3 v2 after limiter fix"

def horizon_of(elapsed_ms):
    """The horizon a drift row measures: |elapsed - 1000h| <= max(2000, 250h), else None."""
    if elapsed_ms is None or (isinstance(elapsed_ms, float) and math.isnan(elapsed_ms)):
        return None
    for h in HORIZONS:
        if abs(elapsed_ms - h * 1000) <= max(2000, h * 250):
            return h
    return None

def n_text(n):
    return f"n={n:,}" + ("  << LOW n" if n < MIN_CONFIDENT_N else "")

drift["h"] = [horizon_of(v) for v in drift["actualElapsedMs"]]
drift["phase"] = drift["t"].map(phase_of)
samples["phase"] = samples["t"].map(phase_of)
print(f"Drift rows on a horizon: {drift['h'].notna().sum():,} of {len(drift):,} ({drift['h'].isna().sum():,} off every horizon, excluded)")
`),

  code(String.raw`
# 4. Data quality: collection gaps, ladder span.
ladder_t = samples.groupby("ladderId")["t"].agg(["min", "max"])
ladder_span_s = ((ladder_t["max"] - ladder_t["min"]) / 1000.0).rename("span_s")
samples = samples.merge(ladder_span_s, left_on="ladderId", right_index=True, how="left")

starts = np.sort(ladder_t["min"].values)
gaps = []
for a, b in zip(starts[:-1], starts[1:]):
    if b - a > 10 * 60_000:
        gaps.append({"from": pd.Timestamp(int(a), unit="ms", tz="UTC").isoformat(),
                     "to": pd.Timestamp(int(b), unit="ms", tz="UTC").isoformat(),
                     "minutes": round((b - a) / 60_000, 1), "n": 1})
print("COLLECTION GAPS (no ladder for over 10 minutes). Left as gaps, never filled:")
for g in gaps:
    print(f"  {g['from']} -> {g['to']}  ({g['minutes']} min)")
if not gaps:
    print("  none")

span_report = []
for phase, grp in samples.drop_duplicates("ladderId").groupby("phase"):
    s = grp["span_s"]
    span_report.append({"phase": phase, "ladders": int(len(s)), "p50SpanS": float(s.median()),
                        "p90SpanS": float(s.quantile(0.9)), "overMaxSpan": int((s > MAX_LADDER_SPAN_S).sum()), "n": int(len(s))})
print("\nLadder span by phase (ladders over", MAX_LADDER_SPAN_S, "s are excluded from impact):")
print(pd.DataFrame(span_report).to_string(index=False))
`),

  code(String.raw`
# 5. Drift coverage (3b). Goes into the report's limitations section verbatim.
coverage_rows = []
for phase in ["1 v1", "2 v2 before limiter fix", "3 v2 after limiter fix"]:
    for depth in ["deep", "thin"]:
        in_phase = drift[(drift["phase"] == phase) & (drift["depth"] == depth)]
        n_sets = in_phase["originSampleId"].nunique()
        for h in HORIZONS:
            on_time = in_phase[in_phase["h"] == h]["originSampleId"].nunique()
            coverage_rows.append({"phase": phase, "depth": depth, "horizonSeconds": h, "originSets": int(n_sets),
                                  "onTime": int(on_time), "onTimePct": round(100.0 * on_time / n_sets, 1) if n_sets else None,
                                  "n": int(n_sets)})
coverage_df = pd.DataFrame(coverage_rows)
print("DRIFT COVERAGE: share of drift sets with an on-time re-quote at each horizon.")
print("A drift set whose every re-quote was dropped leaves no row and is not counted, so these are upper bounds.\n")
print(coverage_df.pivot_table(index=["depth", "horizonSeconds"], columns="phase", values="onTimePct").to_string())
print("\nDrift sets per phase:")
print(coverage_df.drop_duplicates(["phase", "depth"])[["phase", "depth", "originSets"]].to_string(index=False))
five = coverage_df[coverage_df["horizonSeconds"] == 5]
print("\n>>> THE +5 s ROW IS THE ONE THAT MATTERS: simulated fills draw from it.")
print(five[["phase", "depth", "originSets", "onTime", "onTimePct"]].to_string(index=False))
coverage_df.to_csv(os.path.join(OUT_DIR, "report_drift_coverage.csv"), index=False)
`),

  code(String.raw`
# 6. Volatility feature: identical to realisedVolatility in app/lib/fillModel.ts.
series = {}
for pair, grp in samples[samples["ladderRung"] == VOL["rung"]].sort_values("t").groupby("pair"):
    series[pair] = (grp["t"].astype("int64").tolist(), grp["effectivePrice"].astype(float).tolist())

def realised_vol(ts, ps, at_ms):
    """Sample std (ddof=1) of ln(p_i/p_{i-1}) / sqrt(dt_minutes) over the trailing window, x 10000. None if < minReturns."""
    frm = at_ms - VOL["windowMinutes"] * 60_000
    lo = bisect.bisect_left(ts, frm)
    scaled = []
    prev = None
    for i in range(lo, len(ts)):
        t, p = ts[i], ps[i]
        if t > at_ms:
            break
        if t < frm:
            continue
        if prev is not None and p > 0 and prev[1] > 0:
            dt_ms = t - prev[0]
            if dt_ms > 0 and dt_ms <= VOL["maxGapSeconds"] * 1000:
                scaled.append(math.log(p / prev[1]) / math.sqrt(dt_ms / 60_000))
        prev = (t, p)
    if len(scaled) < VOL["minReturns"]:
        return None
    mean = sum(scaled) / len(scaled)
    var = sum((x - mean) ** 2 for x in scaled) / (len(scaled) - 1)
    return math.sqrt(var) * 10_000

origin_vol = {}
for oid, pair, t in drift[["originSampleId", "pair", "t"]].drop_duplicates("originSampleId").itertuples(index=False):
    ts, ps = series.get(pair, ([], []))
    origin_vol[oid] = realised_vol(ts, ps, int(t))
# Numeric with NaN for "no volatility", never an object column.
drift["vol"] = pd.to_numeric(drift["originSampleId"].map(origin_vol), errors="coerce")
print(f"Volatility available for {sum(v is not None for v in origin_vol.values()):,} of {len(origin_vol):,} drift origins")
`),

  code(String.raw`
# 7. Time split: never random. Rows before the cutoff train, the rest test.
times = np.sort(samples["t"].values)
CUTOFF = int(times[int(math.floor(TRAIN_FRACTION * (len(times) - 1)))])
print("Cutoff:", pd.Timestamp(CUTOFF, unit="ms", tz="UTC").isoformat())

impact_rows = samples[(samples["ladderRung"] >= 2) & samples["notionalUsd"].notna()
                      & samples["measuredImpactBps"].notna() & (samples["span_s"] <= MAX_LADDER_SPAN_S)].copy()
imp_train = impact_rows[impact_rows["t"] < CUTOFF]
imp_test = impact_rows[impact_rows["t"] >= CUTOFF]

drift_on = drift[drift["h"].notna()].copy()
drift_on["h"] = drift_on["h"].astype(int)
drift_vol = drift_on[drift_on["vol"].notna()].copy()
d_train = drift_vol[drift_vol["t"] < CUTOFF]
d_test = drift_vol[drift_vol["t"] >= CUTOFF]
for name, frame in [("impact train", imp_train), ("impact test", imp_test), ("drift train", d_train), ("drift test", d_test)]:
    print(f"{name:13s}", "  ".join(f"{d}: {n_text(int((frame['depth'] == d).sum()))}" for d in ["deep", "thin"]))
`),

  code(String.raw`
# 8. Impact table (3d), recomputed over ALL accumulated data. This is the table for the report.
cells_df = samples[samples["notionalUsd"].notna() & (samples["span_s"] <= MAX_LADDER_SPAN_S)]
impact_table = []
for (pair, rung), grp in cells_df[cells_df["measuredImpactBps"].notna()].groupby(["pair", "ladderRung"]):
    b = grp["measuredImpactBps"]
    impact_table.append({"pair": pair, "depth": depth_of(pair), "rung": int(rung), "notionalUsd": float(grp["notionalUsd"].median()),
                         "n": int(len(b)), "p25Bps": float(b.quantile(0.25)), "medianBps": float(b.median()), "p75Bps": float(b.quantile(0.75))})
impact_table_df = pd.DataFrame(impact_table)
pd.set_option("display.width", 200)
for depth in ["deep", "thin"]:
    print(f"\n{depth.upper()} pairs: median impact vs the ~$25 rung (bps), with n")
    sub = impact_table_df[impact_table_df["depth"] == depth]
    if len(sub):
        print(sub.pivot_table(index="rung", columns="pair", values="medianBps").round(1).to_string())
        print(sub.pivot_table(index="rung", columns="pair", values="n").to_string())
impact_table_df.to_csv(os.path.join(OUT_DIR, "report_impact_table.csv"), index=False)
print("\nThese are the cost of NAIVE ON-CHAIN EXECUTION through Jupiter's AMM routing, not of trading that size in general (no RFQ, OTC or CEX liquidity).")

fig, axes = plt.subplots(1, 2, figsize=(13, 4.5))
for ax, depth in zip(axes, ["deep", "thin"]):
    sub = impact_table_df[(impact_table_df["depth"] == depth) & (impact_table_df["rung"] >= 1)]
    for pair, grp in sub.groupby("pair"):
        grp = grp.sort_values("notionalUsd")
        ax.plot(grp["notionalUsd"], grp["medianBps"], marker="o", label=pair)
    ax.set_xscale("log")
    ax.set_yscale("symlog", linthresh=1)
    ax.set_xlabel("notional (USD, log)")
    ax.set_ylabel("median impact vs $25 rung (bps, symlog)")
    ax.set_title(f"{depth} pairs: impact curve (naive on-chain execution)")
    ax.grid(True, alpha=0.3)
    ax.legend(fontsize=8)
plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_impact_curves.png"), dpi=150)
plt.show()
`),

  code(String.raw`
# 9. Impact models: power law per pair (the artifact's model) and a ridge baseline.
def fit_power_law(notional, impact):
    """OLS of log10(impact) on log10(N/1000) over rows above the floor: impact = a (N/1000)^b."""
    mask = (impact > IMPACT_FLOOR_BPS) & (notional > 0)
    x = np.log10(notional[mask] / 1000.0)
    y = np.log10(impact[mask])
    if len(x) < 5:
        return None
    mx, my = x.mean(), y.mean()
    sxx = ((x - mx) ** 2).sum()
    if sxx == 0:
        return None
    b = ((x - mx) * (y - my)).sum() / sxx
    return {"a": float(10 ** (my - b * mx)), "b": float(b), "n": int(len(x)),
            "notionalMinUsd": float(notional[mask].min()), "notionalMaxUsd": float(notional[mask].max())}

per_pair = {}
for pair in PAIRS:
    g = imp_train[imp_train["pair"] == pair]
    fit = fit_power_law(g["notionalUsd"].values, g["measuredImpactBps"].values)
    if fit:
        per_pair[pair] = fit
by_depth = {}
for depth in ["deep", "thin"]:
    g = imp_train[imp_train["depth"] == depth]
    fit = fit_power_law(g["notionalUsd"].values, g["measuredImpactBps"].values)
    if fit:
        by_depth[depth] = fit
for pair, f in per_pair.items():
    print(f"{pair:10s} impact = {f['a']:.4g} x (N/1000)^{f['b']:.3f}   n={f['n']}  fitted over USD {f['notionalMinUsd']:,.0f}..{f['notionalMaxUsd']:,.0f}")

def standardise(train_X, X):
    means = train_X.mean(axis=0)
    stds = train_X.std(axis=0)            # population std, ddof=0, as in the TypeScript reference
    safe = np.where(stds > 0, stds, 1.0)
    return np.where(stds > 0, (X - means) / safe, 0.0), means, stds

def impact_X(frame):
    thin = (frame["depth"] == "thin").astype(float).values
    l = np.log10(frame["notionalUsd"].values)
    return np.column_stack([l, thin, thin * l])

Ztr, _, _ = standardise(impact_X(imp_train), impact_X(imp_train))
Zte, _, _ = standardise(impact_X(imp_train), impact_X(imp_test))
impact_ridge = Ridge(alpha=RIDGE_ALPHA).fit(Ztr, imp_train["measuredImpactBps"].values)
`),

  code(String.raw`
# 10. Drift model: ridge on the contract's three features, with a train-mean baseline.
def drift_features(pair, horizon_s, vol):
    root_t = math.sqrt(horizon_s)
    return [root_t, vol * math.sqrt(horizon_s / 60.0), (1.0 if depth_of(pair) == "thin" else 0.0) * root_t]

def drift_X(frame):
    rows = [drift_features(p, e / 1000.0, v) for p, e, v in zip(frame["pair"], frame["actualElapsedMs"], frame["vol"])]
    return np.array(rows, dtype=float).reshape(-1, 3)

Xtr = drift_X(d_train)
Ztr_d, d_means, d_stds = standardise(Xtr, Xtr)
y_tr = np.maximum(0.0, d_train["driftBps"].values)
drift_ridge = Ridge(alpha=RIDGE_ALPHA).fit(Ztr_d, y_tr)
print("drift ridge: intercept", round(float(drift_ridge.intercept_), 4), "coef", np.round(drift_ridge.coef_, 4).tolist())

vol_fallback_pair = {}
for pair, grp in d_train.drop_duplicates("originSampleId").groupby("pair"):
    vol_fallback_pair[pair] = float(grp["vol"].median())
vol_fallback_depth = {d: float(g["vol"].median()) for d, g in d_train.groupby("depth")}

drift_cells = [{"pair": p, "horizonSeconds": int(h), "n": int(n)}
               for (p, h), n in drift_on.groupby(["pair", "h"]).size().items()]

fig, axes = plt.subplots(1, 2, figsize=(13, 4.5), sharey=True)
for ax, depth in zip(axes, ["deep", "thin"]):
    data = [drift_on[(drift_on["depth"] == depth) & (drift_on["h"] == h)]["driftBps"].values for h in HORIZONS]
    labels = [f"+{h}s\nn={len(v)}" for h, v in zip(HORIZONS, data)]
    ax.boxplot([v if len(v) else [np.nan] for v in data], showfliers=False)
    ax.set_xticks(range(1, len(HORIZONS) + 1))
    ax.set_xticklabels(labels)
    ax.axhline(0, color="grey", lw=0.8)
    ax.set_title(f"{depth} pairs: quote drift by horizon (positive = adverse)")
    ax.set_ylabel("drift (bps)")
plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_drift_by_horizon.png"), dpi=150)
plt.show()
`),

  code(String.raw`
# 11. Short-horizon distributions (failure probability) and volatility tertiles, train only.
train_drift_all = drift_on[drift_on["t"] < CUTOFF]
vol_tertiles = {}
for pair in PAIRS:
    v = sorted(x for x in train_drift_all[train_drift_all["pair"] == pair].drop_duplicates("originSampleId")["vol"] if x is not None and not (isinstance(x, float) and math.isnan(x)))
    vol_tertiles[pair] = [float(np.quantile(v, 1 / 3)), float(np.quantile(v, 2 / 3))] if len(v) >= 3 * MIN_CELL_N else None

def vol_bucket(vol, tertiles):
    if vol is None or tertiles is None or (isinstance(vol, float) and math.isnan(vol)):
        return None
    return "low" if vol < tertiles[0] else ("mid" if vol < tertiles[1] else "high")

groups = {}
for pair, h, d, vol in train_drift_all[["pair", "h", "driftBps", "vol"]].itertuples(index=False):
    keys = [f"{pair}|{h}|all", f"{depth_of(pair)}|{h}|all"]
    b = vol_bucket(vol, vol_tertiles.get(pair))
    if b:
        keys.append(f"{pair}|{h}|{b}")
    for k in keys:
        groups.setdefault(k, []).append(float(d))
GRID = np.linspace(0.0, 1.0, 101)
short_cells = {k: {"n": len(v), "q": [round(float(x), 6) for x in np.quantile(np.array(v), GRID)]}
               for k, v in groups.items() if len(v) >= MIN_CELL_N}
print(f"{len(short_cells)} short-horizon cells with n >= {MIN_CELL_N}; volatility split available for:",
      ", ".join(p for p, t in vol_tertiles.items() if t) or "no pair yet")
`),

  code(String.raw`
# 12. Inference: identical to app/lib/costModel.ts. The self-test vectors below hold the two together.
def resolve_pair(m, pair):
    if pair in m["pairs"]:
        return pair, False
    a, b = pair.split("/")
    rev = f"{b}/{a}"
    if rev in m["pairs"]:
        return rev, True
    return None, False

def nearest_horizon(m, T):
    best = m["constants"]["measuredHorizons"][0]
    for h in m["constants"]["measuredHorizons"]:
        if abs(T - h) < abs(T - best):
            best = h
    return best

def predict_impact(m, pair, N):
    source, reversed_ = resolve_pair(m, pair)
    own = m["impact"]["perPair"].get(source) if source else None
    params = own if own is not None else m["impact"]["byDepth"].get(depth_of(pair))
    if params is None:
        return 0.0, "none"
    value = 0.0 if N <= m["impact"]["baselineNotionalUsd"] else max(0.0, params["a"] * math.pow(N / 1000.0, params["b"]))
    if own is None or reversed_:
        cov = "fallback"
    elif N < params["notionalMinUsd"] or N > params["notionalMaxUsd"]:
        cov = "extrapolated"
    elif params["n"] < m["constants"]["minConfidentN"]:
        cov = "sparse"
    else:
        cov = "ok"
    return value, cov

def predict_drift(m, pair, T, vol):
    source, reversed_ = resolve_pair(m, pair)
    depth = depth_of(pair)
    vol_fallback = False
    if vol is None:
        vol = m["drift"]["volFallbackByPair"].get(source) if source else None
        if vol is None:
            vol = m["drift"]["volFallbackByDepth"].get(depth)
        if vol is None:
            vol = 0.0
        vol_fallback = True
    x = drift_features(pair, T, vol)
    y = m["drift"]["intercept"]
    for i, f in enumerate(m["features"]):
        y += m["drift"]["coef"][i] * ((x[i] - f["mean"]) / f["std"] if f["std"] > 0 else 0.0)
    h = nearest_horizon(m, T)
    cell = next((c for c in m["drift"]["cells"] if source and c["pair"] == source and c["horizonSeconds"] == h), None)
    if T > max(m["constants"]["measuredHorizons"]):
        cov = "extrapolated"
    elif vol_fallback or reversed_ or not source:
        cov = "fallback"
    elif cell is None or cell["n"] < m["constants"]["minConfidentN"]:
        cov = "sparse"
    else:
        cov = "ok"
    return max(0.0, y), cov

def exceedance(q, cap):
    last = len(q) - 1
    if cap < q[0]:
        return 1.0
    if cap >= q[last]:
        return 0.0
    k = 0
    for j in range(last):
        if q[j] <= cap:
            k = j
    u = (k + (cap - q[k]) / (q[k + 1] - q[k])) / last if q[k + 1] > q[k] else (k + 1) / last
    return 1.0 - u

def short_horizon_distribution(m, pair, T, vol):
    h = nearest_horizon(m, T)
    extrapolated = T > max(m["constants"]["measuredHorizons"])
    source, reversed_ = resolve_pair(m, pair)
    found, level = None, "pair"
    if source:
        b = vol_bucket(vol, m["shortHorizon"]["volTertiles"].get(source))
        for key in ([f"{source}|{h}|{b}"] if b else []) + [f"{source}|{h}|all"]:
            if key in m["shortHorizon"]["cells"]:
                found = m["shortHorizon"]["cells"][key]
                break
    if found is None:
        found = m["shortHorizon"]["cells"].get(f"{depth_of(pair)}|{h}|all")
        level = "depth"
    if found is None:
        return None
    q = found["q"]
    if reversed_ and level == "pair":
        q = [-q[len(q) - 1 - k] + 0.0 for k in range(len(q))]
    if extrapolated:
        cov = "extrapolated"
    elif level == "depth" or reversed_:
        cov = "fallback"
    elif found["n"] < m["constants"]["minConfidentN"]:
        cov = "sparse"
    else:
        cov = "ok"
    return {"q": q, "n": found["n"], "coverage": cov}

def predict_failure(m, pair, T, cap, vol):
    dist = short_horizon_distribution(m, pair, T, vol)
    if dist is None:
        return None, "none"
    return exceedance(dist["q"], cap), dist["coverage"]

def predict(m, inp):
    i_v, i_c = predict_impact(m, inp["pair"], inp["notionalUsd"])
    d_v, d_c = predict_drift(m, inp["pair"], inp["horizonSeconds"], inp["volatility"])
    f_v, f_c = predict_failure(m, inp["pair"], inp["horizonSeconds"], inp["capBps"], inp["volatility"])
    return {"impactBps": i_v, "driftAdverseBps": d_v, "failureProbability": f_v,
            "coverage": {"impact": i_c, "drift": d_c, "failure": f_c}}
`),

  code(String.raw`
# 13. Assemble the model (metrics need the predictors, which need the model).
model = {
    "kind": "coinswitch-cost-model", "schemaVersion": 1, "modelVersion": "pending",
    "producer": "colab:notebooks/train_cost_model.ipynb",
    "trainedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    "datasetRowCounts": {"quoteSamples": int(len(samples)), "quoteDrift": int(len(drift_raw))},
    "datasetTimeRange": {"from": pd.Timestamp(int(times[0]), unit="ms", tz="UTC").isoformat(),
                         "to": pd.Timestamp(int(times[-1]), unit="ms", tz="UTC").isoformat()},
    "split": {"method": "time", "cutoff": pd.Timestamp(CUTOFF, unit="ms", tz="UTC").isoformat(),
              "trainRows": {"impact": int(len(imp_train)), "drift": int(len(d_train))},
              "testRows": {"impact": int(len(imp_test)), "drift": int(len(d_test))}},
    "pairs": {p: depth_of(p) for p in PAIRS},
    "constants": {"baselineRung": 1, "impactFloorBps": IMPACT_FLOOR_BPS, "maxLadderSpanSeconds": MAX_LADDER_SPAN_S,
                  "measuredHorizons": HORIZONS, "minCellN": MIN_CELL_N, "minConfidentN": MIN_CONFIDENT_N, "quantilePoints": 101},
    "volatility": VOL,
    "features": [
        {"name": "sqrt_horizon_s", "derivation": "sqrt(horizonSeconds)", "mean": float(d_means[0]), "std": float(d_stds[0])},
        {"name": "vol_sigma_bps", "derivation": "vol_bps_per_sqrt_min * sqrt(horizonSeconds / 60)", "mean": float(d_means[1]), "std": float(d_stds[1])},
        {"name": "thin_sqrt_horizon_s", "derivation": "(1 if thin else 0) * sqrt(horizonSeconds)", "mean": float(d_means[2]), "std": float(d_stds[2])},
    ],
    "impact": {"model": "powerlaw", "baselineNotionalUsd": BASELINE_NOTIONAL_USD, "perPair": per_pair, "byDepth": by_depth,
               "cells": [{"pair": p, "rung": int(r), "notionalUsd": float(g["notionalUsd"].median()), "n": int(len(g))}
                         for (p, r), g in cells_df.groupby(["pair", "ladderRung"])]},
    "drift": {"target": "expected adverse drift E[max(0, D_T)] in bps; D positive = trader gets less",
              "model": "ridge", "alpha": RIDGE_ALPHA, "intercept": float(drift_ridge.intercept_),
              "coef": [float(c) for c in drift_ridge.coef_], "volFallbackByPair": vol_fallback_pair,
              "volFallbackByDepth": vol_fallback_depth, "cells": drift_cells},
    "shortHorizon": {"volTertiles": vol_tertiles, "cells": short_cells},
    "metrics": {}, "reports": {}, "limitations": [], "selfTestVectors": [], "featureTestVectors": [],
}
print("model assembled:", len(per_pair), "pair power laws,", len(short_cells), "short-horizon cells")
`),

  code(String.raw`
# 14. Metrics on the TEST period, deep and thin separately, every one with its n (3a).
def errors(pred, actual):
    pred, actual = np.asarray(pred, dtype=float), np.asarray(actual, dtype=float)
    n = int(len(actual))
    if n == 0:
        return {"n": 0, "mae": None, "rmse": None}
    d = pred - actual
    return {"n": n, "mae": float(np.abs(d).mean()), "rmse": float(np.sqrt((d ** 2).mean()))}

def by_depth_metrics(frame, pred):
    pred = np.asarray(pred, dtype=float)
    out = {}
    for depth in ["deep", "thin"]:
        mask = (frame["depth"] == depth).values
        out[depth] = errors(pred[mask], frame["measuredImpactBps"].values[mask] if "measuredImpactBps" in frame else frame["_y"].values[mask])
    return out

imp_pred = [predict_impact(model, p, n)[0] for p, n in zip(imp_test["pair"], imp_test["notionalUsd"])]
model["metrics"]["impact"] = {"powerLaw": by_depth_metrics(imp_test, imp_pred),
                              "ridgeBaseline": by_depth_metrics(imp_test, impact_ridge.predict(Zte) if len(imp_test) else [])}

d_test = d_test.copy()
d_test["_y"] = np.maximum(0.0, d_test["driftBps"].values)
d_pred = [predict_drift(model, p, e / 1000.0, v)[0] for p, e, v in zip(d_test["pair"], d_test["actualElapsedMs"], d_test["vol"])]
train_mean = {(d, h): float(np.maximum(0.0, g["driftBps"].values).mean()) for (d, h), g in d_train.groupby(["depth", "h"])}
d_base = [train_mean.get((d, h), 0.0) for d, h in zip(d_test["depth"], d_test["h"])]
dt_frame = d_test.drop(columns=["measuredImpactBps"], errors="ignore")
model["metrics"]["drift"] = {"ridge": by_depth_metrics(dt_frame, d_pred), "trainMeanBaseline": by_depth_metrics(dt_frame, d_base)}

# Failure probability: Brier score and reliability, execution horizons, a grid of caps.
CAPS = [1, 2, 5, 10, 20, 50]
test_short = drift_on[(drift_on["t"] >= CUTOFF) & drift_on["h"].isin([5, 15])]
brier, calibration = {}, []
for depth in ["deep", "thin"]:
    rows = []
    for pair, h, d, vol in test_short[test_short["depth"] == depth][["pair", "h", "driftBps", "vol"]].itertuples(index=False):
        vol = None if vol is None or (isinstance(vol, float) and math.isnan(vol)) else vol
        dist = short_horizon_distribution(model, pair, h, vol)
        if dist is None:
            continue
        for cap in CAPS:
            rows.append((exceedance(dist["q"], cap), 1.0 if d > cap else 0.0))
    arr = np.array(rows, dtype=float).reshape(-1, 2)
    brier[depth] = {"n": int(len(arr)), "brier": float(((arr[:, 0] - arr[:, 1]) ** 2).mean()) if len(arr) else None}
    for b in range(10):
        sel = arr[np.minimum(9, np.floor(arr[:, 0] * 10)).astype(int) == b] if len(arr) else arr
        if len(sel):
            calibration.append({"depth": depth, "bin": f"{b / 10:.1f}-{(b + 1) / 10:.1f}", "meanPredicted": float(sel[:, 0].mean()),
                                "observedRate": float(sel[:, 1].mean()), "n": int(len(sel))})
model["metrics"]["failure"] = {"empirical": brier}

def show_metric(target, name, depth, m):
    parts = [f"{k} {v:.3f}" for k, v in m.items() if k != "n" and v is not None]
    print(f"  {target:7s} {name:18s} {depth:5s} {n_text(m['n']):22s} " + "  ".join(parts))
print("TEST-PERIOD METRICS (bps; Brier is unitless)")
for target, models in model["metrics"].items():
    for name, per in models.items():
        for depth, m in per.items():
            show_metric(target, name, depth, m)
cal_df = pd.DataFrame(calibration)
print("\nFailure-probability calibration (predicted vs observed, by bin):")
print(cal_df.to_string(index=False) if len(cal_df) else "  no test rows")

try:
    from sklearn.ensemble import HistGradientBoostingRegressor
    gbt_i = HistGradientBoostingRegressor(max_iter=200, random_state=0).fit(impact_X(imp_train), imp_train["measuredImpactBps"].values)
    gbt_d = HistGradientBoostingRegressor(max_iter=200, random_state=0).fit(Xtr, y_tr)
    model["metrics"]["impact"]["gbtComparison"] = by_depth_metrics(imp_test, gbt_i.predict(impact_X(imp_test)) if len(imp_test) else [])
    model["metrics"]["drift"]["gbtComparison"] = by_depth_metrics(dt_frame, gbt_d.predict(drift_X(d_test)) if len(d_test) else [])
    print("\nGradient-boosted trees, for comparison only (the artifact keeps the baseline models):")
    for target in ["impact", "drift"]:
        for depth, m in model["metrics"][target]["gbtComparison"].items():
            show_metric(target, "gbtComparison", depth, m)
except Exception as exc:
    print("Gradient-boosted comparison skipped:", exc)
`),

  code(String.raw`
# 15. Figures: predicted vs actual, and calibration.
fig, axes = plt.subplots(1, 3, figsize=(17, 4.8))
ax = axes[0]
for depth, colour in [("deep", "tab:blue"), ("thin", "tab:orange")]:
    mask = (imp_test["depth"] == depth).values
    p = np.asarray(imp_pred, dtype=float)[mask]
    a = imp_test["measuredImpactBps"].values[mask]
    ok = (p > 0) & (a > 0)
    ax.scatter(a[ok], p[ok], s=6, alpha=0.4, color=colour, label=f"{depth} (n={int(ok.sum())} with both > 0)")
ax.set_xscale("log"); ax.set_yscale("log")
lims = [0.1, 20000]
ax.plot(lims, lims, color="grey", lw=0.8)
ax.set_xlabel("measured impact (bps)"); ax.set_ylabel("predicted (bps)")
ax.set_title("impact: predicted vs measured, test period"); ax.legend(fontsize=8)

ax = axes[1]
for depth, colour in [("deep", "tab:blue"), ("thin", "tab:orange")]:
    mask = (d_test["depth"] == depth).values
    ax.scatter(d_test["_y"].values[mask], np.asarray(d_pred, dtype=float)[mask], s=8, alpha=0.4, color=colour, label=f"{depth} (n={int(mask.sum())})")
ax.set_xlabel("realised adverse drift max(0, D) (bps)"); ax.set_ylabel("predicted (bps)")
ax.set_title("adverse drift: predicted vs realised, test period"); ax.legend(fontsize=8)

ax = axes[2]
ax.plot([0, 1], [0, 1], color="grey", lw=0.8)
for depth, colour in [("deep", "tab:blue"), ("thin", "tab:orange")]:
    sub = cal_df[cal_df["depth"] == depth] if len(cal_df) else cal_df
    if len(sub):
        ax.plot(sub["meanPredicted"], sub["observedRate"], marker="o", color=colour, label=f"{depth} (n={int(sub['n'].sum())})")
ax.set_xlabel("predicted P(drift > cap)"); ax.set_ylabel("observed frequency")
ax.set_title("failure probability calibration, test period"); ax.legend(fontsize=8)
plt.tight_layout()
plt.savefig(os.path.join(OUT_DIR, "fig_predicted_vs_actual.png"), dpi=150)
plt.show()
`),

  code(String.raw`
# 16. Directional assumption (3e): is drift for B/A the mirror image of drift for A/B?
def ks_stat(a, b):
    xs, ys = np.sort(a), np.sort(b)
    i = j = 0
    d = 0.0
    while i < len(xs) and j < len(ys):
        v = min(xs[i], ys[j])
        while i < len(xs) and xs[i] <= v:
            i += 1
        while j < len(ys) and ys[j] <= v:
            j += 1
        d = max(d, abs(i / len(xs) - j / len(ys)))
    return d

directional = []
for pair in PAIRS:
    a, b = pair.split("/")
    rev = f"{b}/{a}"
    if not (pair < rev and rev in PAIRS):
        continue
    for h in HORIZONS:
        fwd = drift_on[(drift_on["pair"] == pair) & (drift_on["h"] == h)]["driftBps"].values
        neg_rev = -drift_on[(drift_on["pair"] == rev) & (drift_on["h"] == h)]["driftBps"].values
        enough = len(fwd) >= MIN_CELL_N and len(neg_rev) >= MIN_CELL_N
        stat = float(ks_stat(fwd, neg_rev)) if enough else None
        crit = float(1.36 * math.sqrt((len(fwd) + len(neg_rev)) / (len(fwd) * len(neg_rev)))) if enough else None
        directional.append({"pair": pair, "reverse": rev, "horizonSeconds": h, "nForward": int(len(fwd)), "nReverse": int(len(neg_rev)),
                            "n": int(len(fwd) + len(neg_rev)),
                            "medianForward": float(np.median(fwd)) if len(fwd) else None,
                            "medianNegatedReverse": float(np.median(neg_rev)) if len(neg_rev) else None,
                            "ks": stat, "ksCritical5pct": crit,
                            "verdict": "insufficient data" if not enough else ("consistent with sign flip" if stat <= crit else "rejects sign flip at 5%")})
directional_df = pd.DataFrame(directional)
print("Drift(A/B) vs -Drift(B/A), two-sample KS at 5%. The thin pairs were only sampled in one direction, so the flip cannot be tested for them.")
print(directional_df.to_string(index=False) if len(directional_df) else "  no pair was sampled in both directions")
directional_df.to_csv(os.path.join(OUT_DIR, "report_directional_test.csv"), index=False)
`),

  code(String.raw`
# 17. Reports, limitations, and the test vectors that tie this notebook to the TypeScript.
model["reports"] = {"driftCoverage": coverage_rows, "impactTable": impact_table, "directionalTest": directional,
                    "calibration": calibration, "collectionGaps": gaps, "ladderSpanByPhase": span_report}

low = [f"{t}/{n}/{d} n={m['n']}" for t, ms in model["metrics"].items() for n, per in ms.items() for d, m in per.items() if m["n"] < MIN_CONFIDENT_N]
model["limitations"] = [
    "Impact is the cost of naive on-chain execution through Jupiter's AMM routing (swap/v1 quote); RFQ market makers, OTC desks and centralised venues are not seen.",
    f"Dataset spans {model['datasetTimeRange']['from']} to {model['datasetTimeRange']['to']} with {len(gaps)} collection gap(s) over 10 minutes (reports.collectionGaps); gaps are left as gaps.",
    "Deep-pair +5 s drift before the limiter fix was lost systematically, not at random (reports.driftCoverage).",
    "Drift beyond 60 s is extrapolated from the volatility feature, not measured.",
    "Reverse-direction predictions assume drift is a sign flip; see reports.directionalTest for where that could be checked.",
    "Simulated fills and MEV are outside this model; MEV was never measured.",
] + ([f"Metrics with n below {MIN_CONFIDENT_N}: " + "; ".join(low)] if low else [])

inputs = [
    {"pair": "SOL/USDC", "notionalUsd": 100, "horizonSeconds": 5, "capBps": 50, "volatility": 2.5},
    {"pair": "SOL/USDC", "notionalUsd": 1_000_000, "horizonSeconds": 5, "capBps": 50, "volatility": None},
    {"pair": "USDC/SOL", "notionalUsd": 40_000, "horizonSeconds": 15, "capBps": 10, "volatility": 3},
    {"pair": "SOL/USDT", "notionalUsd": 5, "horizonSeconds": 30, "capBps": 5, "volatility": 1},
    {"pair": "BONK/USDC", "notionalUsd": 100, "horizonSeconds": 5, "capBps": 1, "volatility": 4},
    {"pair": "BONK/USDC", "notionalUsd": 200_000, "horizonSeconds": 5, "capBps": 50, "volatility": None},
    {"pair": "WIF/USDC", "notionalUsd": 10_000, "horizonSeconds": 15, "capBps": 20, "volatility": 5},
    {"pair": "WIF/USDC", "notionalUsd": 2_000_000, "horizonSeconds": 60, "capBps": 50, "volatility": 8},
    {"pair": "JUP/USDC", "notionalUsd": 40_000, "horizonSeconds": 120, "capBps": 30, "volatility": 4},
    {"pair": "USDC/BONK", "notionalUsd": 1_000, "horizonSeconds": 5, "capBps": 10, "volatility": 4},
    {"pair": "SOL/BONK", "notionalUsd": 50_000, "horizonSeconds": 5, "capBps": 50, "volatility": None},
    {"pair": "USDT/USDC", "notionalUsd": 500, "horizonSeconds": 5, "capBps": 2, "volatility": 0.2},
    {"pair": "JUP/USDC", "notionalUsd": 20, "horizonSeconds": 0, "capBps": -5, "volatility": 0},
]
model["selfTestVectors"] = [{"input": inp, "expected": predict(model, inp)} for inp in inputs]

fv = []
for pair in ["BONK/USDC", "SOL/USDC", "WIF/USDC"]:
    ts, ps = series.get(pair, ([], []))
    if len(ts) < 20:
        continue
    at = ts[-1]
    window = [(t, p) for t, p in zip(ts, ps) if t >= at - 31 * 60_000]
    fv.append({"series": [[int(t), float(p)] for t, p in window], "atMs": int(at),
               "expectedVol": realised_vol([t for t, _ in window], [p for _, p in window], at)})
ts, ps = series.get("SOL/USDC", ([], []))
if len(ts) >= 4:
    fv.append({"series": [[int(t), float(p)] for t, p in zip(ts[:4], ps[:4])], "atMs": int(ts[3]), "expectedVol": realised_vol(ts[:4], ps[:4], ts[3])})
gap_at = next((i for i in range(1, len(ts)) if ts[i] - ts[i - 1] > 600_000), None)
if gap_at:
    lo, hi = max(0, gap_at - 10), gap_at + 10
    fv.append({"series": [[int(t), float(p)] for t, p in zip(ts[lo:hi], ps[lo:hi])], "atMs": int(ts[lo:hi][-1]),
               "expectedVol": realised_vol(ts[lo:hi], ps[lo:hi], ts[lo:hi][-1])})
model["featureTestVectors"] = fv
print(len(model["selfTestVectors"]), "self-test vectors,", len(fv), "feature-test vectors")
`),

  code(String.raw`
# 18. Write cost-model.json (strict JSON: no NaN), check it, and download everything.
def clean(x):
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating, float)):
        return None if (math.isnan(float(x)) or math.isinf(float(x))) else float(x)
    if isinstance(x, (np.bool_,)):
        return bool(x)
    return x

model = clean(model)
digest = hashlib.sha256(json.dumps({"perPair": model["impact"]["perPair"], "cells": model["shortHorizon"]["cells"],
                                    "coef": model["drift"]["coef"]}, sort_keys=True).encode()).hexdigest()[:8]
model["modelVersion"] = "cost-" + model["trainedAt"].replace("-", "").replace(":", "")[:13] + "Z-" + digest

REQUIRED_KEYS = ["kind", "schemaVersion", "modelVersion", "producer", "trainedAt", "datasetRowCounts", "datasetTimeRange", "split",
                 "pairs", "constants", "volatility", "features", "impact", "drift", "shortHorizon", "metrics", "reports",
                 "limitations", "selfTestVectors", "featureTestVectors"]
problems = [k for k in REQUIRED_KEYS if k not in model]
problems += ["fewer than 12 selfTestVectors"] if len(model["selfTestVectors"]) < 12 else []
problems += ["fewer than 3 featureTestVectors"] if len(model["featureTestVectors"]) < 3 else []
problems += [f"metric without n: {t}/{n}/{d}" for t, ms in model["metrics"].items() for n, per in ms.items() for d, m in per.items() if "n" not in m]
print("structural check:", "OK" if not problems else problems)

artifact_path = os.path.join(OUT_DIR, "cost-model.json")
with open(artifact_path, "w") as fh:
    json.dump(model, fh, indent=1, allow_nan=False)
print("wrote", artifact_path, f"({os.path.getsize(artifact_path) / 1024:.0f} KB)", model["modelVersion"])

bundle = shutil.make_archive(os.path.join("/content" if IN_COLAB else ".", "coinswitch_cost_model_outputs"), "zip", OUT_DIR)
if IN_COLAB:
    colab_files.download(artifact_path)
    colab_files.download(bundle)
else:
    print("outputs in", OUT_DIR, "and", bundle)
`),

  code(String.raw`
# 19. Paste-back summary.
lines = [
    f"COST MODEL {model['modelVersion']}  ({model['producer']})",
    f"data {model['datasetRowCounts']['quoteSamples']:,} samples / {model['datasetRowCounts']['quoteDrift']:,} drift rows, {model['datasetTimeRange']['from']} .. {model['datasetTimeRange']['to']}",
    f"split by time at {model['split']['cutoff']}: train impact {model['split']['trainRows']['impact']:,} / drift {model['split']['trainRows']['drift']:,}; test impact {model['split']['testRows']['impact']:,} / drift {model['split']['testRows']['drift']:,}",
    f"collection gaps over 10 min: {len(gaps)}",
    "TEST METRICS (deep and thin separately; every number with n):",
]
for target, models in model["metrics"].items():
    for name, per in models.items():
        for depth, m in per.items():
            vals = "  ".join(f"{k} {v:.3f}" for k, v in m.items() if k != "n" and v is not None)
            lines.append(f"  {target}/{name}/{depth}: n={m['n']} {vals}" + ("  LOW n" if m["n"] < MIN_CONFIDENT_N else ""))
lines.append("+5 s DRIFT COVERAGE (on-time % of drift sets):")
for r in coverage_rows:
    if r["horizonSeconds"] == 5:
        lines.append(f"  {r['phase']} {r['depth']}: {r['onTime']}/{r['originSets']} = {r['onTimePct']}%")
lines.append("DIRECTIONAL TEST:")
for r in directional:
    lines.append(f"  {r['pair']} vs -{r['reverse']} +{r['horizonSeconds']}s: n={r['nForward']}/{r['nReverse']} -> {r['verdict']}")
lines.append(f"artifact: {len(model['impact']['perPair'])} pair power laws, {len(model['shortHorizon']['cells'])} short-horizon cells, "
             f"{len(model['selfTestVectors'])} self tests, {len(model['featureTestVectors'])} feature tests")
lines.append("NEXT: put cost-model.json in models/ and run: npm run validate:model")
print("\n".join(lines))
`),
];

const notebook = {
  cells,
  metadata: {
    colab: { provenance: [], name: "train_cost_model.ipynb" },
    kernelspec: { name: "python3", display_name: "Python 3" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 0,
};

for (const cell of notebook.cells) {
  cell.source = cell.source.split(/(?<=\n)/);
}

fs.mkdirSync("notebooks", { recursive: true });
fs.writeFileSync("notebooks/train_cost_model.ipynb", JSON.stringify(notebook, null, 1) + "\n");
console.log(`wrote notebooks/train_cost_model.ipynb (${cells.length} cells)`);

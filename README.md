# Memecoin Radar

*[Français](README.fr.md)*

A real-time pipeline and statistical test bench, applied to a concrete case: new tokens launched on [Pump.fun](https://pump.fun).

The bot listens to the live feed, filters and scores each token, sends alerts, then **measures what actually happened next**. The test bench answers the real question: *does this strategy make money, or is it chance?*

> **Result of the study: none of the strategies tested is proven profitable.** That is a useful result: the tool is built to put ideas that look good to the test, not to confirm them. See [the results](#results).
>
> The tool's console output, error messages and code comments are in French.

## What this project demonstrates

| Skill | Where to see it |
|---|---|
| **Resilient real-time feed**: WebSocket, exponential-backoff reconnection, subscriptions replayed after a drop, capacity handling | `src/sources/pumpListener.ts` |
| **Integration of fragile external APIs**: rate-limit-respecting queue, parallel IPFS gateways with retry, graceful degradation when a service goes down | `src/enrichment/` |
| **Testable architecture**: every dependency is injected, the same code runs in production and in tests | `src/radar.ts` |
| **Statistical rigor**: placebo control (permutation test), bootstrap confidence intervals, multiple-testing correction, fixed seed | `src/analysis/` |
| **Quality**: strict TypeScript, 118 tests, check that the tests catch regressions | `tests/` |

## One-command start

No key, no account, no network needed. Node.js 22 or newer.

```bash
npm ci && npm run demo
```

The demo replays the test bench on the **1,184 tokens actually tracked** in September 2026 (file provided in `data/sample/`) and prints the full report in under a second. Same seed, same figures, on every run. Token names and symbols there are replaced by aliases (`Token 0001`, `TK0001`); addresses, prices and scores are as recorded. The report is printed in French.

## Results

On 919 candidates with price history, entry at the alert price and **perfect** execution (hence optimistic):

- **The score ranks candidates well.** The median peak goes from ×1.16 (score < 50) to ×1.42 (score ≥ 90).
- **But that peak cannot be cashed in.** It is a maximum measured after the fact. As soon as a real exit is simulated (profit target, trailing stop, sale at a fixed time: 21 rules tested), the mean stays below ×1.00. The best one reaches ×0.99, before fees.
- **No hypothesis is proven profitable.** Out of 14 strategy ideas (one of which had too little data to be tested), none has a net mean significantly above ×1.00.

```
Hypothesis                                        n   Gross     Net     95% CI (net)   placebo p   profitable p*   Proven
Score ≥ 70 and holders < 80%, target ×1.25      354   ×0.94   ×0.91   [×0.85; ×0.97]       0.350           1.000       no
Entry ≥ 100 SOL, target ×1.25                   396   ×0.98   ×0.95   [×0.89; ×1.01]       0.015           1.000       no
Entry ≥ 150 SOL + X link, target ×1.25           59   ×1.05   ×1.02   [×0.89; ×1.13]       0.052           1.000       no
Buy on crossing $40k, sell at $50k              271   ×0.88   ×0.85   [×0.79; ×0.90]           —           1.000       no
```

`*` = p-value corrected for the 14 hypotheses tested (Bonferroni). The block above is an excerpt of the tool's French output, translated: labels in English, numbers unchanged, decimal points instead of commas.

**How to read these rows.** Two different questions, two columns:

- *"Better than chance?"* (`placebo p`, uncorrected). The "entry ≥ 100 SOL" filter does better than random subgroups of the same size (p ≈ 0.015): sorting by entry size therefore helps a little. After correction for the 14 tests (and the dozens of trials made while exploring), this result is no longer significant.
- *"Profitable?"* (`CI` and `profitable p`). Even the best filter stays below ×1.00 after fees (×0.95). **Better sorted does not mean profitable.** The "X link, ×1.05" subgroup (59 candidates) *looks* like a winner, but its confidence interval runs from ×0.89 to ×1.13: nothing allows us to say it makes money.

- **Paper-trading simulation over 223 trades**: mean ×0.943 before fees, ×0.913 after fees, i.e. −1.93 simulated SOL. Some sessions are positive, others heavily negative: that is what a zero edge looks like.

## Architecture

```
PumpPortal feed (WebSocket)
        │  new token + every trade
        ▼
  45 s observation          ← the token is tracked, its trades are accumulated
        │
        ▼
  Stage 1: free filter      ← ≥ 5 unique buyers and market cap ×1.5 (zero API calls)
        │  only a small fraction passes
        ▼
  Stage 2: enrichment       ← holders and authorities (Helius), social links (IPFS)
        │
        ▼
  Score /100 ──────────────► Telegram alert (if ≥ 70)
        │                    Paper position (if holders < 80%)
        ▼
  Price tracking ──────────► outcomes.jsonl   (what really happened)
                                   │
                                   ▼
                    Test bench: calibration, exit rules,
                    hypotheses + placebo + multiple-testing correction
```

The two-stage filter has a precise reason: the free Helius plan is rate-limited, while thousands of tokens are created per day. Stage 1 uses only data already received and discards most of them before the first paid call.

| Folder | Role |
|---|---|
| `src/radar.ts` | Pipeline orchestrator (dependencies injected) |
| `src/sources/` | WebSocket feed, reconnection, subscriptions |
| `src/enrichment/` | Queued Helius client, IPFS metadata, SOL price |
| `src/scoring/` | Free filter, 100-point scale (pure function), signal collection |
| `src/tracking/` | Price tracking after scoring, name-wave detection |
| `src/execution/` | Position management and **paper** broker |
| `src/notify/` | Telegram alerts (falls back to the console without configuration) |
| `src/analysis/` | Statistics, exit rules, hypothesis battery, report |
| `scripts/backtest.ts` | Command line of the test bench |
| `data/sample/` | Real dataset, names anonymized: 1,185 tracked candidates, 464 paper orders |

## Running the bot live

```bash
cp .env.example .env     # then fill in the keys you want
npm run dev
```

All keys are optional: without Helius, the on-chain criteria earn no points; without Telegram, alerts are printed to the console. Results are written to `logs/outcomes.jsonl` and `logs/paper-trades.jsonl`. For a long run: `npm run build && npm start`.

The feed's trades are billed by volume by the provider (about 0.01 SOL per 10,000 messages), including in simulation.

## The test bench

```bash
npm run backtest                        # on logs/outcomes.jsonl (otherwise the provided sample)
npm run backtest -- --input my-file.jsonl --trades logs/paper-trades.jsonl
npm run backtest -- --json              # output usable by another tool
npm run backtest -- --seed 7 --iterations 20000 --sol-usd 150
```

**Method.** For each strategy idea, the test bench asks two distinct questions:

1. **Is it profitable?** Bootstrap confidence interval on the mean multiplier *after fees*; the mean must exceed ×1.00. The median is displayed but is not enough: a ×1.25 target shows a median of ×1.13 while the mean stays at ×0.93, because of rare, heavy losses.
2. **Is it better than chance?** Placebo control: thousands of random subgroups of the same size are drawn from the same population, with the same exit rule, and we look at the share that do at least as well. A filter that does not beat its placebos captures nothing.

The p-values are then corrected with the Bonferroni method for the number of hypotheses tested (a harsh method, on purpose: these ideas are correlated with one another), and a subgroup of fewer than 20 candidates is never tested. A hypothesis is "proven" only if both conditions hold.

## Tests

```bash
npm test          # 118 tests
npm run check     # type check + tests
```

The full pipeline is tested end to end with a fake feed, fake enrichment services and a manual scheduler (time only advances when the test decides). The exit rules, the scoring scale, the placebo and the statistics are tested on hand-computed cases. The tests were also checked by mutation: deliberately breaking a key behavior (scoring threshold, position limit, name-wave fix) makes at least one test fail.

## Acknowledged limitations

- **Execution assumed perfect.** The simulations buy and sell at the last known price, with no latency or slippage. A real trade would do worse. Fees are estimated (2% round trip + priority fees), never measured on real orders.
- **The hypotheses are tested on the same 919 candidates**, and several dozen combinations were explored before the final battery was written: the real number of trials is higher than the 14 counted. A real validation would need new tokens, with a hypothesis frozen in advance.
- **Pump.fun only**, and *bonding curve* price only: after migration to another market, the true peak may be higher.
- **Short tracking window** (5 to 15 minutes): slower moves are not seen.
- **Tracking in progress lives in memory.** If the process stops before a window ends, that result is lost.
- **Sample data**: token names are freely entered by their creators and may contain anything; they were replaced by aliases. Two names that are identical once normalized (case, spaces) get the same alias, so waves of copies remain visible; the test bench's output is identical to the one obtained with the original names.

## Design choices

**No live trading, on purpose.** The repository ships only the paper broker: no wallet, no private key, no transaction. The measurements above show the strategy loses money; connecting funds to it would make no sense. The `Broker` interface (`src/execution/broker.ts`) remains the extension point if another use case justifies it.

**A pure scoring scale, separated from network calls.** `scoreInputs()` does no I/O: that is what makes it possible to test every threshold of the scale. Signal collection (`Scorer`) is isolated and replaceable.

**Defects fixed during cleanup**: a "name wave" tracking overwrote the history and score of an already-tracked token (the row lost its original entry price and no longer triggered a report); the open-positions limit could be exceeded if two candidates were evaluated at the same time (the slot is now reserved before the purchase).

## Disclaimer

This project is an analysis tool, not financial advice. Memecoin markets are extremely speculative and, according to the data above, none of the strategies tested showed an edge there.

## License

© 2026 Samuel Mateo. All rights reserved.

The code and the sample data are published to be read and evaluated. Without the author's written permission, they may not be copied, modified or redistributed.

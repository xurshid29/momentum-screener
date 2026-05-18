# Catching Low-Float Momentum Runners

Strategy notes + roadmap for detecting micro-cap explosions early. Companion to
the live screener — see [web-dashboard.md](web-dashboard.md) for what's built.
Notes as of May 2026.

## The opportunity

Low-float micro-caps repeatedly explode +100% to +1000%+ on a catalyst, and the
setup rhymes every time. The goal: detect them **early and systematically** —
not after they've already 5×'d.

## Reframe: detection, not prediction

You cannot predict, the night before, which dead $0.40 stock pops tomorrow — the
catalyst is exogenous (a company decides to drop a PR). What you *can* do is
**be in within the first few minutes, with full context, every time.** The edge
is three things:

1. **Pre-qualification** — know the candidate universe in advance.
2. **Detection latency** — seconds, not minutes, from ignition to alert.
3. **Filtering** — act only on the few high-quality setups.

## The pattern — three case studies

| | QUCY | AEHL | SNAL |
|---|---|---|---|
| Company | Mainz Biomed → "Quantum Cyber" | China Ceramics → "Antelope" | Snail (ARK games) |
| Catalyst | Promo PR (drone IP license) | Promo PR ($190K BTC "gain") | Real Q1 earnings beat |
| Move | ~+1,400% | ~+1,150% | ~+200% |
| Float | 10.7M | 2.3M | 13.5M |
| Pre-move price | ~$0.40 | ~$0.50 | ~$0.53 |
| Liquidity before | dead | dead (96K sh/day) | dead |
| Short squeeze? | No (8.9%) | No (<1%) | Yes (11%) |
| Dilution vehicle | going concern, serial offerings | effective F-3 shelf + S-8 | S-1 (effective Dec '25) |

**Shared DNA (true *before* the move):** tiny float (<~15M), low price (<~$2),
dead/illiquid, often a recent reverse split, and frequently a prior pump
(serial runners recur).

**The trigger:** a catalyst headline + a volume explosion, almost always
pre-market or at a session open.

**What differs:** catalyst *quality*. QUCY/AEHL were promotional pumps; SNAL was
a genuine earnings beat. The screener catches all three — quality decides how
you *trade* it, not whether to *catch* it.

## The setup checklist — pre-qualify, don't predict

Maintain a nightly-refreshed watchlist of every NASDAQ/NYSE name matching the
*structural* setup:

- Float < ~15–20M
- Price < ~$5
- Low average dollar-volume (illiquid)
- Bonus tells: recent reverse split; has run before

A few hundred names. You don't pick the winner — you pre-load every candidate so
detection latency is zero when one ignites.

## Two screeners, not one

Keep the current Momentum screener exactly as-is; **add a second Ignition
screener.** They are different tools, and folding Ignition logic into the
Momentum screener would flood the clean confirmation board with noise.

| | Momentum (current) | Ignition (planned) |
|---|---|---|
| Job | Ride *confirmed* runs | Catch the *first minutes* |
| Led by | change % (≥20%) | volume burst (`rel_vol_5min`) |
| Price band | $1–25 | $0.30+ (sub-$1 included) |
| Float ceiling | < 35M | < ~15M |
| Noise | low | higher — by design |

They overlap naturally: a stock *ignites* on Ignition, then *graduates* to
Momentum as the run matures.

## Detection signals, ranked by earliness

1. **Relative-volume burst** — `rel_vol_5min`. Volume precedes price; a dead
   5M-float name doing 30× its normal 5-min volume *before* it is even +20% is
   the earliest tell. The current screener leads with change % — a
   *confirmation*, not a *detection*, signal.
2. **Trade halts** — a T1 ("news pending") halt = catalyst landing now, tape
   frozen. Watching the halt feed → ready for the resumption gap. *(Built.)*
3. **Catalyst news / filings** — a fresh PR or 8-K/424B on a low-float name.
   *(News + SEC EDGAR feeds built; the catalyst classifier scores them.)*
4. **change %** — last and laggiest.

## Composite "runner score"

Fuse the signals into one score per ticker per cycle, and alert only on the
top few:

- Float — smaller = higher
- `rel_vol_5min` burst magnitude
- Catalyst score (from the classifier)
- Earliness — penalize names already +200% (too late)
- Halt flag

Alert hard on a score threshold; rank the Ignition board by it. The danger of
"catch everything" is that everything looks urgent and nothing does.

## The database is a predictive asset — repeat runners

Serial runners recur — same float, same promoters, same reverse-split vehicle
(AEHL and QUCY had both pumped before). Compute per ticker: *"had a ≥50% up-day
in the last N months."*

**Constraint:** the `screener_results` history is only ~2 weeks deep today.
Don't wait six months — **backfill from Finviz `quote_export` daily bars**: pull
~12 months of daily bars for every float-qualified ticker, count >50% up-days,
store a `historical_runs` count. Instant prior; the own-DB history then
compounds on top of it.

## Alerts — Telegram (done)

Server-side Telegram push from the poller — alerts reach you 24/5 regardless of
whether a browser tab is open (the key upgrade over the browser sound /
notification, which needs the tab open). Currently fires on fresh news +
strong/major catalyst, deduped once per article. The Ignition runner-score
becomes a second, higher-priority alert source through the same pipe.

## Risk — what "catching more" does not solve

- **Survivorship bias.** For every QUCY there are dozens of low-float names that
  pop +40% and die, halt *down* into a delisting, or are offering traps. A
  screener that catches every low-float mover catches a lot of garbage. The edge
  is **ranking + filtering + position sizing**, not raw coverage.
- **Dilution is the recurring kill-switch.** A loaded, *effective* shelf
  (S-1/S-3/F-3) plus an ATM is a company's mechanism to sell stock into a spike.
  AEHL's F-3 went effective three days before its pump. Flag effective shelves
  from the EDGAR feed — a shelf + a 500% spike = an offering is coming.
- These setups are also prime **short / fade** candidates once parabolic and
  extended.

## Roadmap

- **Phase 1 — Telegram alerts.** ✅ Done. Server-side push for fresh
  high-catalyst rows; dedup per article; no-ops without the env vars.
- **Phase 2 — Ignition screener.** ✅ Done. A second, volume-led Finviz screen
  (sub-$1, float < 15M) run each cycle + the composite runner-score + a compact,
  always-visible Ignition sidebar, persisted to `ignition_results`, with Telegram
  alerts on runner-score ≥ 58 or a bullish strong/major catalyst. Spec:
  [ignition-screener-spec.md](ignition-screener-spec.md).
- **Phase 3 — Refinements.** Finviz daily-bar backfill for repeat-runner stats;
  surface the EDGAR shelf/dilution flag on rows and alerts.

## Latency note

20s Finviz polling is fine for these — all three case studies ran for hours to
days. True first-*tick* detection would need a websocket quote feed
(Polygon / IBKR), a big lift for marginal gain. The high-value work is Phases
2–3 above, not shaving the poll interval.

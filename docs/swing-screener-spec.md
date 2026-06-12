# Swing Screener — Spec

Implementation spec for a second-generation screener targeting **multi-day swing
setups** (hold 1–5 days), running alongside the existing intraday Momentum and
Ignition screens. See [web-dashboard.md](web-dashboard.md) for what's built and
[catching-runners.md](catching-runners.md) for the intraday strategy this
*doesn't* overlap with — Swing is a deliberately different beast.

**Status:** shipped 2026-05-29 — all six steps of §9 complete. Locked
defaults from §11 are the live behavior. Tuning items live in
[`web-dashboard.md`](web-dashboard.md) under "Swing screener — deferred /
tuning".

## 1. Why a separate screen

The intraday Momentum + Ignition screens are optimized for the *first minutes*
of a move — earliness, volume bursts, sub-$1 nano-floats. Empirically (see
[web-dashboard.md](web-dashboard.md) "Empirical session performance") that's a
poor fit for the operator's time zone (UTC+5): Pre-market alerts arrive too
fast to act on, After-hours alerts arrive while asleep, and even the Regular
session demands constant screen attention to capture the few real winners.

Swing closes that gap. It surfaces names where the **edge persists overnight**
— a clean breakout from a multi-day base, a gap-and-hold on a real catalyst, a
trend continuation off the 20-day SMA. Holds are 1–5 days, entries are
planned (set the alert at 09:30 ET, decide in the first hour, hold or exit
based on chart structure rather than the screener score).

The current Momentum + Ignition screens stay exactly as they are — Swing is
additive, surfaced via a `[Momentum] [Swing]` tab switch on the existing
Screener panel.

## 2. The Swing Finviz screen

A third `fetchScreener()` call, but on a **slower cadence** than the 20s
intraday loop (see §4 — every N cycles, not every cycle). Universe is
deliberately *broader* than Ignition since multi-day moves come from
small-to-mid-caps, not nano-floats:

| Param | Value | Why |
|---|---|---|
| Finviz filter | `ind_stocksonly,sh_price_o2,sh_price_u50,sh_avgvol_o500,sh_relvol_o1.5` | $2–$50, avg-vol ≥ 500K (real liquidity), today's RVol ≥ 1.5 (real interest today) |
| `floatMaxM` | `100` | post-filter ceiling — small-to-mid, not nano |
| `floatMinM` | `5`  | post-filter floor — avoid the squeeze universe that belongs in Ignition |
| `topN` | `100` | fetch wide, then swing-score-rank down to ~25 |
| code post-filter | `mcap_m >= 50` | drop the smallest microcaps |

The same `volume not in Finviz filter` gotcha as the others — float ceiling
and mcap floor are post-filtered in code so Finviz doesn't silently drop
null-field rows.

Constants in code for v1 (a `SWING_DEFAULTS` block). Not user-editable via
the Filters dialog yet — the goal is to lock a known-good filter first and
tune from data.

## 3. The swing-score

A new `apps/api/src/services/swing-score.ts` — pure function
`scoreSwing(row, dailyBars) → { score, breakdown }`, 0–100. Unlike
runner-score, this score *requires daily-bar history* — see §6.

**Recalibrated 2026-06-13 ("early volatile breakout") against 508 detections
with a full 5-day outcome horizon.** The original (v1) weights were inverted
against the screener's goal: the ≥65 alert set had the *lowest* forward
upside (peak_5d +2.8 vs +8.4 for sub-50 scores); full SMA alignment (Trend
25) peaked +5.6 vs +9.5 for the below-SMA50 reversal class it disqualified;
the at-52w-high reward selected the worst upside band; the textbook
5-day-base→breakout combo did worst of all (+4.2); and ATR — the single
strongest upside predictor (≥8% ATR: 15% of detections peak ≥+20%, 5% ≥+40%;
<3%: zero ever reached +20) — wasn't scored. v2, reconstructed on the same
history: **≥60 → peak_5d +12.1, 17% ≥+20, 7% ≥+40 (~3.5 det/day)**; day-1
fresh crosses peaked +14.4 with the shallowest drawdowns. Mean chg_5d is
negative in every bucket — these names bleed on a passive 5-day hold; the
score targets *peak capture* (enter the fresh break, exit into strength).

| Component | Max | Logic |
|---|---|---|
| **Volatility** | 25 | ATR-14 as % of price: ≥ 10% → 25; ≥ 8% → 22; ≥ 6% → 15; ≥ 4% → 7; below → 0 (a sub-4%-ATR large-cap structurally cannot print the 40–50% multi-day move this screen hunts) |
| **Room** | 15 | distance *below* the 52w high: ≥ 30% below → 15; 15–30% → 10; 5–15% → 5; at the high → 3 (inverts v1's "strength" — depth is room to run, and the depressed bases are the downtrend-reversal setups) |
| **Trigger** | 30 | fresh range-high cross + base quality + close strength (see §3.1) |
| **Volume confirmation** | 15 | today's volume vs 20-day avg: ≥ 2.5x → 15; ≥ 1.5x → 10; ≥ 1.0x → 5 |
| **Trend** | 10 | light structure nudge, no longer a gate: price > 50-SMA → +5; 50-SMA > 200-SMA → +5 (a reversal name can reach the alert line without it) |
| **Catalyst durability** | 10 | bullish strong/major durable type → 10; bullish strong/major other → 6; bullish watch → 3; bearish → 0 (halved from v1 — the setup carries the score) |
| **Extension penalty** | −15…0 | price vs 20-SMA: ≥ 30% above → −15; ≥ 15% → −8 (chg_5d bleeds monotonically with extension; 30% above the 20-SMA is mid-parabola, not starting) |
| **Shelf penalty** | −25…0 | `active`→−25, `effective`→−15, `shelf`→−7. Heavier than intraday because a multi-day hold gives the company time to file a takedown. |

Final score clamped 0–100. Sort desc, take top ~25 for the swing tab.
Alert line: **≥ 60** AND (day-1/day-2 fresh breakout OR fresh bullish
strong/major catalyst).

### 3.1 Trigger subscore (out of 30)

Three signals on the daily bars, scored independently and summed:

- **Fresh breakout** (max 20) — today is the FIRST close above the prior
  15-bar high → 20 (`broke_out`, the alert trigger); second day of that
  cross → 12 (`broke_out_5d`); still above but crossed ≥3 bars ago → 4;
  not above → 0. Plain "above the prior high" stays true on every bar of a
  ramp — freshness is what makes it a *starting* breakout, and the same
  mechanism catches a flat-consolidation break and the first thrust out of
  a downtrend base.
- **Base quality** (max 6) — prior **15** closes (excluding today) within a
  15% range → 6 (`in_base`); within 25% → 3; else 0. (v1's 5-day ≤10% base
  mostly proxied low volatility — outcome data showed those names had the
  lowest forward peaks.)
- **Close strength** (max 4) — today's close in top 25% of day's range → 4;
  in top 50% → 2; below midpoint → 0.

The composite captures "multi-week range → first expansion bar through the
range high → close on the highs" — the *start* of the move, not its middle.

## 4. Backend — cadence and integration

Swing **shares the existing 20s poll loop** but only re-evaluates every N
cycles (default N=60 ≈ 20 min). Reasons:

- Daily bars don't change intraday — there's no value in recomputing every 20s.
- The Finviz screener call has a real cost (HTTP RTT + rate-limit budget); we
  don't need to spend it every cycle for the Swing universe.
- A swing trader checks the list periodically, not on every tick.

Implementation: a `swingCycleCounter` on `PollerService`. When
`counter % 60 === 0`, fetch the Swing screen, enrich + score, persist,
broadcast. Between those cycles, the last computed view is broadcast unchanged
(so a newly-connecting SSE client doesn't get an empty list).

End-of-day forced refresh at **16:30 ET** (post-close) — guarantees the next
day's watchlist is current.

### 4.1 Daily-bar dependency (Phase 3b — currently paused)

The swing-score needs the last ~250 trading days of daily OHLCV per ticker
to compute SMAs, 52w high, ATR, base detection, and breakout signals. The
existing screener has no daily-bar history — this is exactly the paused Phase
3b backfill from [catching-runners.md](catching-runners.md):

- Source: Finviz `quote_export?t=TICKER&p=d` — daily bars, free with Elite.
- Storage: a new `daily_bars` table keyed `(ticker, date)`.
- Backfill: one-time fill for the current Swing universe (~500 names × 250
  days = 125k rows — trivial). Run nightly to add the new bar.
- Live update: today's bar is partial until close; refreshed each Swing scan
  using the latest `screener_results` row's `price`/`volume` plus the
  intraday session high/low (best effort).

**This backfill is a hard prerequisite** — building the swing-score before
the bars exist would just produce nulls. The plan is to ship the UI scaffold
+ spec doc first (steps 1–2 of the implementation plan), then do the backfill,
then turn on the score.

## 5. Persistence — `swing_results`

A dedicated table, fully separate from `screener_results` and
`ignition_results`. Records the swing-score *as of evaluation time* so the
weights are tunable from real outcomes later.

```sql
create table swing_results (
    id                uuid primary key default extensions.uuid_generate_v4(),
    cycle_id          uuid not null references screener_cycles(id) on delete cascade,
    ticker            varchar(16) not null,
    swing_score       numeric(5, 2) not null,
    score_breakdown   jsonb not null,        -- per-component scores
    price             numeric(12, 4),
    change_pct        numeric(8, 4),
    float_m           numeric(12, 4),
    mcap_m            numeric(12, 4),
    volume            bigint,
    avg_volume_20     bigint,
    -- Daily-bar context — snapshot of the inputs to the score, useful for
    -- the post-hoc "did the setup work" backtest.
    sma_20            numeric(12, 4),
    sma_50            numeric(12, 4),
    sma_200           numeric(12, 4),
    high_52w          numeric(12, 4),
    atr_14            numeric(12, 4),
    in_base           boolean,
    broke_out         boolean,
    close_in_top_q    boolean,
    catalyst_score    integer,
    catalyst_type     varchar(32),
    shelf_level       varchar(16),
    created_at        timestamptz not null default current_timestamp
);
create index idx_swing_results_cycle  on swing_results (cycle_id);
create index idx_swing_results_ticker on swing_results (ticker);
create index idx_swing_results_score  on swing_results (swing_score desc);
```

Shares `screener_cycles` (no new cycle table) — each Swing scan references
the cycle it ran inside, even though Swing only runs every Nth cycle.
Measuring outcomes is a forward-join (ticker → daily_bars next-N-days).

## 6. Frontend — the Swing tab

Modifications to `apps/web/src/components/screener/ScreenerPanel.tsx`: wrap
the current table in an antd `Tabs` with two items:

- **Momentum** (default, key=`momentum`) — current behaviour, unchanged.
- **Swing** (key=`swing`) — new table reading `payload.swing` (a new array on
  `CyclePayload`).

The Swing table has its own column set, tuned for daily-bar context:

| Col | Source | Notes |
|---|---|---|
| Ticker | `ticker` | reuses `TickerLink` |
| Score | `swing_score` | color-tiered like runner-score |
| Setup | `score_breakdown.setup` + flags | compact "base+brk+strg" icon strip |
| Price | `price` | |
| Day Chg % | `change_pct` | colored |
| Dist 52WH | `(price - high_52w) / high_52w` | negative %; tooltip with `$high_52w` |
| vs 20-SMA | `(price - sma_20) / sma_20` | colored, threshold ±5% |
| Vol vs Avg | `volume / avg_volume_20` | "Nx" |
| Cat | catalyst score + 🔥 | shared with Momentum |
| Shelf | shelf badge | shared with Momentum |

Selection drives the existing `useSelection()` — clicking a swing row lights
up Quote Details, News Room, and the Chart grid exactly like a Momentum row.
**Ignition sidebar stays visible** in both tabs (it's an always-on intraday
discovery feed, not a "screen mode" you pick).

Quote Details gets no new tab — the existing Details / History / Ignition
tabs already cover swing context. (Could add a "Swing" sub-tab later showing
the daily-bar score breakdown, but not v1.)

## 7. Telegram — Swing alerts

A `pushSwingAlerts()` in the poller, fired on the periodic Swing eval. Push
once per ticker per ET day when:

- `swing_score ≥ 60` (v2, 2026-06-13) **and** at least one of `broke_out` /
  `broke_out_5d` (day-1 / day-2 fresh cross) or
  `bullish strong/major catalyst this cycle` is true.

Deduped via `alertedSwing: Set<ticker>`, cleared at midnight. Message:
ticker · swing-score + breakdown · price · day chg · setup flags · catalyst ·
links. Reuses `telegram.ts`.

Also adds a `/swing` command to the existing Telegram bot — returns the top-5
swing setups (matching the existing `/momentum`, `/ignition` pattern).

## 8. Types

- `SwingRow = EnrichedRow & { swing_score: number; score_breakdown: SwingScoreBreakdown; setup_flags: { in_base, broke_out, close_in_top_q }; daily_context: { sma_20, sma_50, sma_200, high_52w, atr_14, avg_volume_20, dist_52w_high_pct } }`
- `CyclePayload.swing: SwingRow[]` — added in both `apps/api/src/db/types.ts`
  and `apps/web/src/api/types.ts`.
- `SwingResultsTable` — Kysely interface mirroring the migration.
- `DailyBarsTable` — new Kysely interface for the backfill.

## 9. Implementation plan — phased

All six steps shipped 2026-05-28 → 2026-05-29 as separate commits:

1. ✅ **Spec doc** ← this file.
2. ✅ **UI scaffold** — `[Momentum] [Swing]` tabs in `ScreenerPanel.tsx`.
3. ✅ **Daily-bar backfill** — `daily_bars` table, `DailyBarsService`
   pulling Finviz `quote_export`, midnight-ET invalidate hook in the poller.
4. ✅ **Swing scan + score + persistence** — `SWING` constants, third
   `fetchScreener()` call gated on the cycle counter, `swing-score.ts`,
   `swing_results` migration, broadcast wiring.
5. ✅ **Swing table UI** — `SwingTable.tsx`, fed by `payload.swing` from SSE.
6. ✅ **Telegram /swing + alerts** — `pushSwingAlerts()` and the `/swing`
   bot command (alias `/sw`).

## 10. v1 scope cuts (deliberate)

- **Swing filter is a code constant** — not user-editable via the Filters
  dialog. Same pattern as Ignition.
- **One global Swing list** — not per-user, like the rest of the screener.
- **No backtest endpoint/UI** — `swing_results` *is* persisted (so the score
  is tunable later), but querying outcomes is ad-hoc psql for v1.
- **No swing-specific charts** — uses the existing chart grid. Default
  interval could optionally bump to `1h` or `D` when a Swing row is selected;
  v1 keeps it whatever the user last picked.
- **No "watchlist" curation** — the score does all the ranking. A "saved
  setups" feature can come later if needed.
- **Daily-bar source = Finviz only.** Could add Yahoo or Polygon later as a
  fallback for delisted/halted-long tickers, but Finviz `quote_export` covers
  the live universe.

## 11. Confirmed decisions (locked 2026-05-28)

All defaults accepted as proposed in earlier sections. Listed here so the
v1 wire-up doesn't drift:

1. **Swing cadence** — every 60 cycles (≈20 min) inside the existing 20s
   poll loop, plus a forced 16:30 ET post-close refresh.
2. **Alert threshold** — v1 locked `swing_score ≥ 65` + `broke_out`;
   superseded 2026-06-13 by v2: `≥ 60` + day-1/day-2 fresh cross (see §3/§7).
3. **Universe price range** — `$2–$50`.
4. **Float range** — `5M–100M` (post-filter; min mcap `$50M`).
5. **Score weights** — Trend 25 + Strength 15 + Setup 25 + Volume 15 +
   Catalyst 20; Shelf penalty −25…0. Catalyst sits below Trend on purpose:
   a clean mechanical setup is the more reliable signal; the catalyst weight
   captures the *durability* component on top of that.
6. **Daily-bar source** — Finviz `quote_export?t=TICKER&p=d` (we already use
   Finviz Elite; Yahoo as fallback if/when needed for delisted/long-halted
   tickers).
7. **`broke_out` semantics** — v1 scored 5-day/10-day prior-high breaks;
   superseded 2026-06-13: `broke_out` = day-1 FRESH cross of the prior
   15-bar high, `broke_out_5d` = day-2 of that cross (column names kept,
   meaning changed — see §3.1). A stale still-above-the-range no longer
   flags or alerts.

If later data motivates a change, retune §3's weights against the recorded
`swing_results` outcomes rather than ad-hoc.

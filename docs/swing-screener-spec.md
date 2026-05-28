# Swing Screener — Spec

Implementation spec for a second-generation screener targeting **multi-day swing
setups** (hold 1–5 days), running alongside the existing intraday Momentum and
Ignition screens. See [web-dashboard.md](web-dashboard.md) for what's built and
[catching-runners.md](catching-runners.md) for the intraday strategy this
*doesn't* overlap with — Swing is a deliberately different beast.

**Status:** defaults locked (2026-05-28). UI scaffold (step 2 of §9) shipped;
the rest of §9 is pending. The open decisions in §11 are all accepted as
written — see that section for the confirmed values.

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

| Component | Max | Logic |
|---|---|---|
| **Trend** | 25 | full alignment (price > 20-SMA > 50-SMA > 200-SMA) → 25; 3-of-3 partial → 18; price > 20-SMA only → 10; below 50-SMA → 0 |
| **Strength** | 15 | distance from 52w high: within 5% → 15; 5–15% → 10; 15–30% → 5; > 30% → 0 |
| **Setup pattern** | 25 | composite of base detection + breakout + close strength (see §3.1) |
| **Volume confirmation** | 15 | today's volume vs 20-day avg: ≥ 2.5x → 15; ≥ 1.5x → 10; ≥ 1.0x → 5 |
| **Catalyst durability** | 20 | bullish strong/major catalyst with `catalyst_type ∈ {fda_approval, m&a, earnings_beat, contract_win, regulatory_approval}` → 20; bullish strong/major (other type) → 12; bullish watch → 5; bearish → 0 |
| **Shelf penalty** | −25…0 | `active`→−25, `effective`→−15, `shelf`→−7. Heavier than intraday because a multi-day hold gives the company time to file a takedown. |

Final score clamped 0–100. Sort desc, take top ~25 for the swing tab.

### 3.1 Setup-pattern subscore (out of 25)

Three signals on the *last 10 daily bars*, scored independently and summed:

- **Base detection** (max 10) — last 5 closes within a 10% range → 10; within
  15% → 6; within 20% → 3; else 0. A tight base just before a breakout is the
  ideal setup.
- **Breakout** (max 10) — today's close above the high of the prior 5 days
  (small breakout) → 5; above the high of prior 10 days (larger breakout) → 10.
- **Close strength** (max 5) — today's close in top 25% of day's range → 5;
  in top 50% → 3; below midpoint → 0.

The composite captures "tight base → expansion bar → close on the highs," which
is the canonical swing entry.

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

- `swing_score ≥ 65` **and** at least one of `broke_out` or
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

The full system is too big for one commit; ship in order:

1. **Spec doc** ← this file. Confirm rules before building. ✅ (when this lands)
2. **UI scaffold** — `[Momentum] [Swing]` tabs in `ScreenerPanel.tsx`; Swing
   tab renders a "Coming soon" stub + a preview of the planned columns.
   Tiny self-contained commit; visible to the user immediately.
3. **Daily-bar backfill** — Phase 3b. Migration for `daily_bars`, a
   `DailyBarsService` that pulls Finviz `quote_export` for the Swing
   universe, persists, and refreshes nightly. Wire to the poller's midnight
   reset block.
4. **Swing scan + score + persistence** — `SWING_DEFAULTS`, second
   `fetchScreener()` call gated on the cycle counter, `swing-score.ts`,
   `swing_results` migration, broadcast wiring.
5. **Swing table UI** — replace the stub with the real table fed by
   `payload.swing` from SSE.
6. **Telegram /swing + alerts** — `pushSwingAlerts()` and the bot command.

Each step is a separate commit. Steps 2–5 can be paused between commits
without breaking anything (the new columns and tables are nullable / unread
by default).

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
2. **Alert threshold** — `swing_score ≥ 65`, additionally requires
   `broke_out` or a bullish strong/major catalyst this cycle.
3. **Universe price range** — `$2–$50`.
4. **Float range** — `5M–100M` (post-filter; min mcap `$50M`).
5. **Score weights** — Trend 25 + Strength 15 + Setup 25 + Volume 15 +
   Catalyst 20; Shelf penalty −25…0. Catalyst sits below Trend on purpose:
   a clean mechanical setup is the more reliable signal; the catalyst weight
   captures the *durability* component on top of that.
6. **Daily-bar source** — Finviz `quote_export?t=TICKER&p=d` (we already use
   Finviz Elite; Yahoo as fallback if/when needed for delisted/long-halted
   tickers).
7. **`broke_out` semantics** — score both 5-day and 10-day prior-high breaks
   (5-day worth 5 pts, 10-day worth 10 pts, additive inside §3.1). Alert
   trigger requires the 10-day break (the bigger signal).

If later data motivates a change, retune §3's weights against the recorded
`swing_results` outcomes rather than ad-hoc.

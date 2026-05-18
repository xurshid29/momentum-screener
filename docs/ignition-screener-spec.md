# Ignition Screener — Phase 2 Spec

Implementation spec for Phase 2 of the runner-detection roadmap. See
[catching-runners.md](catching-runners.md) for the strategy this builds on.

**Status:** ✅ built (2026-05-17). Decisions taken: sidebar on the left edge,
Telegram alert threshold runner-score ≥ 58, v1 cuts accepted.

## 1. What it delivers

A second, **volume-led** screener running in the same 20s poll cycle as the
Momentum screener — tuned to catch low-float names in the *first minutes* of
ignition. Surfaced as an always-visible **ranked sidebar**, scored by a
composite **runner-score**, wired into Telegram alerts, and **persisted** —
every row's runner-score is recorded so the score can be tuned/backtested
later. The current Momentum screener is untouched.

## 2. The Ignition Finviz screen

A second `fetchScreener()` call per cycle with its own filter. Following the
existing momentum design (CLAUDE.md gotcha — float in the Finviz filter drops
null-float nano-caps), **float is NOT in the Finviz string** — it's
post-filtered in code:

| Param | Value | Why |
|---|---|---|
| Finviz filter | `ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o500` | under $10 (includes sub-$1), relvol > 2, real volume > 500K — **no change% filter** (volume leads, not price) |
| `floatMaxM` | `15` | post-filter ceiling (vs Momentum's 35) |
| `topN` | `80` | fetch wide, then runner-score-rank down to the displayed top ~15 |
| code post-filter | `price >= 0.10` | drop sub-dime junk (`sh_price_u10` has no lower bound) |

Constants in code for v1 (an `IGNITION_DEFAULTS` block) — *not* user-editable
via the Filters dialog yet.

## 3. The runner-score

A new `apps/api/src/services/runner-score.ts` — pure function
`scoreRunner(row) → { score, breakdown }`, 0–100:

| Component | Max | Logic |
|---|---|---|
| **Float** | 30 | `<2M→30`, `<5M→25`, `<10M→16`, `<15M→8`, else 0 |
| **Volume burst** | 35 | `rel_vol_5min`: `≥3000→35`, `≥1000→27`, `≥500→18`, `≥200→8`; fallback day-RVol `≥10→6` |
| **Catalyst** | 25 | direction-aware — bullish `score×0.25`, neutral/mixed `score×0.10`, **bearish → 0** |
| **Change** | −35…0 | extended up: `≥300→−20`, `≥150→−12`, `≥80→−5`; **down-move: `≤−15→−35`, `<0→−12`** |
| **Halt** | +12 | a halt headline this cycle (T1/T2 = catalyst landing now) |

Clamped 0–100. The sidebar ranks by it; the breakdown is shown on hover.

## 4. Backend — poller restructure

The meat. `runCycle()` becomes a **two-screen cycle** — fetch both, enrich the
union once, produce two views:

1. **Fetch** — `Promise.all([fetchScreener(momentum), fetchScreener(ignition)])`.
   Two `ScreenerRow[]` sets; union them into a `Map<ticker, ScreenerRow>`,
   tracking `momentumTickers` / `ignitionTickers` sets.
2. **News** — fetched once for the **union** of tickers (the 5 sources +
   watermarks stay shared — critical, so EDGAR/halt/Benzinga watermarks aren't
   double-advanced).
3. **Enrich** — the existing per-row enrichment (`rel_vol_5min` from
   `volHistory`, catalyst, news merge) runs over the union. Extracted into an
   `enrichRow()` helper.
4. **Two views** — `rows` = enriched ∈ momentumTickers (today's behavior);
   `ignition` = enriched ∈ ignitionTickers, each + `runner_score`, sorted desc,
   top ~25.
5. **Persist** — Momentum rows → `screener_results` (unchanged); ignition rows →
   the new `ignition_results` table, in the same transaction, referencing the
   same `screener_cycles` row.
6. **Broadcast** — one `cycle` payload carrying both arrays.

Files: `poller.ts` (significant but contained — it's `runCycle` + 2 helpers),
`finviz.ts` (no change — `fetchScreener` already takes a filter), new
`runner-score.ts`, one `db/migrations/` file.

### Persistence — `ignition_results`

A dedicated table keeps ignition rows fully separate from momentum data — zero
impact on existing `screener_results` queries — and records the runner-score
*as it was at ignition time*, which is what makes the score tunable later
(backtest: "did `score ≥ 58` actually go on to run?").

```sql
create table ignition_results (
    id              uuid primary key default extensions.uuid_generate_v4(),
    cycle_id        uuid not null references screener_cycles(id) on delete cascade,
    ticker          varchar(16) not null,
    runner_score    numeric(5,2) not null,
    score_breakdown jsonb not null,          -- per-component scores
    price           numeric(12,4),
    change_pct      numeric(8,4),
    float_m         numeric(12,4),
    rel_volume      numeric(12,4),
    rel_vol_5min    numeric(12,4),
    catalyst_score  integer,
    news_source     varchar(16),
    created_at      timestamptz not null default current_timestamp
);
create index idx_ignition_results_cycle  on ignition_results (cycle_id);
create index idx_ignition_results_ticker on ignition_results (ticker);
create index idx_ignition_results_score  on ignition_results (runner_score desc);
```

The poll cycle is shared, so ignition rows reference the existing
`screener_cycles` row — no separate cycle table. Measuring outcomes is a
forward-join (ticker → later price history); ad-hoc via psql for now — a
backtest endpoint/UI is a later add, not Phase 2.

## 5. Telegram — Ignition alerts

A `pushIgnitionAlerts()` in the poller fires on either trigger — an ignition
row's `runner_score ≥ 58`, **or** a bullish strong/major catalyst (catches a
catalyst-led move before the volume burst lifts the score; bearish catalysts
never alert). Deduped **once per ticker per ET day** (`alertedIgnition`, cleared
at midnight). Message: ticker · runner-score + breakdown · price · %chg · float
· RVol5m · catalyst · links. Reuses the existing `telegram.ts`.

## 6. Frontend — the Ignition sidebar

New `apps/web/src/components/screener/IgnitionSidebar.tsx`:

- A compact, always-visible ranked list — top ~15 by runner-score.
- Each row: **ticker** · **score** (color-tiered: ≥75 red / 55–75 orange /
  40–55 yellow / dim) · price · %chg · a mini-line (float · RVol5m · 🔥). Score
  breakdown on hover.
- Click a row → `setSelected(ticker)` — drives the existing charts + Quote
  panels via `SelectionContext`.
- Added as a new panel in `DashboardPage`'s outer `PanelGroup`
  (`id="ms-pane-ignition"`), **left edge** — scan order becomes Ignition →
  Screener → Charts. Resizable, ~220px default.

Reads `payload.ignition` — `useScreenerStream` needs no change (same `cycle`
event).

## 7. Types

- `IgnitionRow = EnrichedRow & { runner_score: number; score_breakdown: RunnerScoreBreakdown }`
- `CyclePayload.ignition: IgnitionRow[]` — added both in
  `apps/api/src/db/types.ts` and `apps/web/src/api/types.ts`.
- `IgnitionResultsTable` — Kysely table interface added to the `Database` type
  in `apps/api/src/db/types.ts`, mirroring the migration.

## 8. v1 scope cuts (deliberate)

- **Ignition filter is a code constant** — not user-editable via the Filters
  dialog.
- **Ignition sidebar always-visible** — no hide toggle (charts are hideable; the
  ignition feed is the thing you must not miss).
- **No backtest endpoint/UI** — ignition rows *are* persisted (see §4), but
  querying outcomes is ad-hoc psql for now; a tuning UI is a later add.
- Runner-score weights are code constants (easy to tune).

## 9. Files touched

New: a `db/migrations/` SQL file (`ignition_results`), `runner-score.ts`,
`IgnitionSidebar.tsx`. Modified: `poller.ts`, `db/types.ts` (api), `api/types.ts`
(web), `DashboardPage.tsx`, and the docs (`CLAUDE.md` + `catching-runners.md`
mark Phase 2 done). One migration, no new dependency.

## 10. Open decisions — confirm or override

1. **Sidebar placement** — left edge (recommended, scan-order
   Ignition→Screener→Charts) or right edge?
2. **Ignition alert threshold** — runner-score `≥ 58`. Looser (more alerts) or
   tighter?
3. **v1 cuts OK?** — specifically: the ignition filter not user-editable yet,
   and no backtest UI (ad-hoc psql for tuning).

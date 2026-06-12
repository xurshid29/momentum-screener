# Ignition Screener — Phase 2 Spec

Implementation spec for Phase 2 of the runner-detection roadmap. See
[catching-runners.md](catching-runners.md) for the strategy this builds on.

**Status:** ✅ built (2026-05-17); runner-score **recalibrated 2026-06-12** from
forward outcomes (see §3). Telegram alert threshold runner-score ≥ 65.

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
| Pre-market filter | `ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o100` | session-aware override (premarket only) — same gates with the volume floor dropped to 100K so nano-floats become visible before they've already ripped through the regular-session threshold (the WHLR post-mortem) |
| `floatMaxM` | `15` | post-filter ceiling (vs Momentum's 35) |
| `topN` | `80` | fetch wide, then runner-score-rank down to the displayed top ~15 |
| code post-filter | `price >= 0.10` | drop sub-dime junk (`sh_price_u10` has no lower bound) |

Constants in code for v1 (an `IGNITION_DEFAULTS` block) — *not* user-editable
via the Filters dialog yet.

## 3. The runner-score

A `apps/api/src/services/runner-score.ts` — pure function
`scoreRunner(row) → { score, breakdown }`, 0–100.

**Recalibrated 2026-06-12** against 22 days of forward-return outcomes
(`screener_outcomes`). The study found the original score under-ranked its own
best cohort: a fresh, regular-hours ignition up 25–100% intraday scored ~45
(below the alert line) yet did **+14.9%/1d and held +14%/5d**, the only ignition
slice that didn't give back — while the score spent its budget on catalyst
*impact* and shelf risk, both miscalibrated for the 1-day horizon. The rebalance
(validated: alert set `≥65` → +13.9%/1d, holds +5.2%/5d, vs the old `≥58` rule's
+4.7%/1d that gave back to −0.4% by day 5):

| Component | Range | Logic | Why (outcomes) |
|---|---|---|---|
| **Float** | 0…30 | `<2M→30`, `<5M→25`, `<10M→16`, `<15M→8`, else 0 | `<2M` is the best 1d cohort |
| **Volume** | 0…30 | `max` of two ladders — 5-min burst (`≥3000→30`, `≥1000→24`, `≥500→16`, `≥200→7`) **and** day-RVol (`≥25→24`, `≥10→14`, `≥5→7`, `≥3→3`) | `rel_vol_5min` is null/0 ~40% of the time; day-RVol predicts cleanly (25×+ → +4.4%/1d) and is no longer a mere fallback |
| **Catalyst** | −15…+15 | type-aware, **not** impact-scaled: dilution/bankruptcy `−12`; M&A/legal `−8`; partnership/contract/13D-G/earnings `−5`; **FDA/clinical `+14`**; news-pending halt `+10`, news halt `+8`, vol/info halt `+4`; other bearish `−8`; else `0` | impact_score did **not** predict (high-impact trended negative); *type* did — FDA holds 5d, dilution/M&A/partnership fade, catalyst *absence* is the best alert cell so it stays neutral |
| **Maturity** | −25…+12 | `≤−15→−25`, `<0→−12`, `<25→0`, **`25–100→+12`**, `<150→−6`, `<300→−15`, else `−25` | the 25–100% band is the sweet spot (rewarded, was a flat 0); >100% blows off; red is a non-runner |
| **Pre-market** | −8…0 | `seen_in_premarket → −8` | a name that already ran in PM gave back (0.0%/1d vs +14.9% for the fresh regular-hours version) |
| **Shelf** | −5…0 | `active → −5`, else 0 | the old `effective→−10 / shelf→−5` penalty was **inverted** at 1d — those names out-performed; an effective shelf is a *multi-day* kill-switch (still rides as the ⚠️), not a same-session drag |

Clamped 0–100. The sidebar ranks by it; the breakdown is shown on hover. The
`halt` and `earliness` breakdown keys were replaced by `maturity` + `premarket`
+ a halt-aware `catalyst`.

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
row's detection score `≥ 65` (the score minus the shelf component, so dilution
risk never *hides* an alert), **or** a premium catalyst (the type-aware catalyst
component scoring `≥ 8` — FDA/clinical or a news-pending/news halt — catches a
catalyst-led move before the volume burst lifts the score). Suppressed when the
current change% is already `> 100` (blow-off), and bearish/dilution catalysts
never alert. Deduped **once per ticker per ET day** (`alertedIgnition`, cleared
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

**Phase 3 refinement.** The sidebar is split into a pinned **New** section
(tickers in the Ignition set under 2 min — surfaced regardless of runner-score,
so a fresh name whose 5-min RVol isn't measurable yet isn't buried) above the
score-ranked **Top** list. Rows carry an `is_new` flag; the poller bypasses the
`broadcast_n` score cutoff for new rows so a low-scored fresh name still reaches
the payload.

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
2. **Ignition alert threshold** — runner-score `≥ 65` (set 2026-06-12 from
   outcomes; the sweep showed 58→~10/day +8.9%/1d, 70→~2/day +24.6%/1d). Revisit
   the volume/conviction trade as more outcomes accrue on the new score.
3. **v1 cuts OK?** — specifically: the ignition filter not user-editable yet,
   and no backtest UI (ad-hoc psql for tuning).

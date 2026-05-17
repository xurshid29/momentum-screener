# Ignition Screener — Phase 2 Spec

Implementation spec for Phase 2 of the runner-detection roadmap. See
[catching-runners.md](catching-runners.md) for the strategy this builds on.

**Status:** spec — pending approval (3 open decisions at the bottom).

## 1. What it delivers

A second, **volume-led** screener running in the same 20s poll cycle as the
Momentum screener — tuned to catch low-float names in the *first minutes* of
ignition. Surfaced as an always-visible **ranked sidebar**, scored by a
composite **runner-score**, and wired into Telegram alerts. The current Momentum
screener is untouched.

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
| **Catalyst** | 25 | `catalyst.score × 0.25` (0 if no catalyst) |
| **Earliness** | −20…0 | penalize late: `change% ≥300→−20`, `≥150→−12`, `≥80→−5`, else 0 |
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
5. **Persist** — Momentum only (see scope cuts). Unchanged.
6. **Broadcast** — one `cycle` payload carrying both arrays.

Files: `poller.ts` (significant but contained — it's `runCycle` + 2 helpers),
`finviz.ts` (no change — `fetchScreener` already takes a filter), new
`runner-score.ts`.

## 5. Telegram — Ignition alerts

A new `pushIgnitionAlerts()` in the poller: fires when an ignition row's
`runner_score ≥ 65`, deduped **once per ticker per ET day** (`alertedIgnition`
set, cleared at midnight). Message: ticker · runner-score + breakdown · price ·
%chg · float · RVol5m · catalyst · links. Reuses the existing `telegram.ts` —
higher-priority sibling of the current momentum alerts.

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

## 8. v1 scope cuts (deliberate)

- **No DB persistence** of ignition rows — live + alerts only. ⇒ **no
  migration**, lower risk. Phase 3 adds a `screen` discriminator column.
- **Ignition filter is a code constant** — not user-editable via the Filters
  dialog.
- **Ignition sidebar always-visible** — no hide toggle (charts are hideable; the
  ignition feed is the thing you must not miss).
- Runner-score weights are code constants (easy to tune).

## 9. Files touched

New: `runner-score.ts`, `IgnitionSidebar.tsx`. Modified: `poller.ts`,
`db/types.ts` (api), `api/types.ts` (web), `DashboardPage.tsx`, and the docs
(`.env.example` n/a; `CLAUDE.md` + `catching-runners.md` mark Phase 2 done). No
migration, no new dependency.

## 10. Open decisions — confirm or override

1. **Sidebar placement** — left edge (recommended, scan-order
   Ignition→Screener→Charts) or right edge?
2. **Ignition alert threshold** — runner-score `≥ 65`. Looser (more alerts) or
   tighter?
3. **v1 cuts OK?** — specifically: ignition rows not persisted, and the ignition
   filter not user-editable yet.

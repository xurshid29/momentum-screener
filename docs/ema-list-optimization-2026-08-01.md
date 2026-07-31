# 5m EMA Reclaim List Optimization — Investigation and Plan

**Investigation date:** 2026-08-01  
**Production cohort:** 2026-07-30 04:00 ET through 2026-08-01 04:00 ET  
**Purpose:** reduce the operator's 5m EMA list without losing the rare explosive runners  
**Status:** direction check; display-only optimization proposed, no detection or alert change

Related references:

- [`reclaim-strategy-investigation-2026-07-30.md`](reclaim-strategy-investigation-2026-07-30.md) — first production review and null-control correction
- [`detection-layers.md`](detection-layers.md) — current reclaim mechanics
- [`HANDOVER.md`](HANDOVER.md) — live operating state and semantics boundaries
- [`../apps/api/scripts/research/reclaim-grading.sql`](../apps/api/scripts/research/reclaim-grading.sql) — reproducible funnel and outcome queries

## Question

The 5m reclaim lane produces too many confirmed rows. Most move less than the
operator's meaningful 10–20% range, while a small number—FCUV, CYCU, DFNS and
similar names—make outsized moves.

Can information already available around the 5m confirmation rank the list so
the explosive tail receives attention without changing or disabling the
underlying detector?

## Cohort and outcome definition

The study used production `tier_events` where:

```sql
tier = 'cross'
event = 'confirm'
meta->>'signal' = 'reclaim'
meta->>'tf' = '5m'
at >= timestamptz '2026-07-30 04:00:00-04'
at <  timestamptz '2026-08-01 04:00:00-04'
```

This is the first two-day window with persisted 5m `open/high/low`. A confirm
was evaluable when it had at least four subsequent persisted bars inside the
first 60 minutes. The resulting cohort contained **162 confirms**.

The primary tail outcome was:

```text
maximum live MINI high >= confirmation price × 1.20
within the available bars up to 240 minutes after confirmation
```

Eleven of 162 confirms met that definition. The 240-minute result is an
available-bar outcome, not guaranteed four-hour coverage: sparse tickers and
confirmations near session boundaries may have shorter effective windows.

All features below were restricted to information available at or near the
confirmation. The study does not use the eventual outcome as an input.

## Headline finding

An **actual higher-timeframe reclaim confirmation near the 5m confirmation** is
the strongest observed way to reduce the list.

“HTF co-confirm” means a confirmed reclaim on 15m, 1h, 4h, or 1d between two
minutes before and two minutes after the 5m confirmation. In a live UI, a 5m
row can therefore be promoted for up to two minutes after it first appears.

| Candidate rule | Rows | Reduction vs all | Reached +20% | Tail precision | Large runners retained |
|---|---:|---:|---:|---:|---:|
| All 5m confirms | 162 | — | 11 | 6.8% | 11/11 |
| Any HTF nomination/confirm | 44 | 72.8% | 10 | 22.7% | 10/11 |
| Actual HTF **confirm** | 37 | 77.2% | 10 | 27.0% | 10/11 |
| HTF confirm + volume ratio `>=20x` | 24 | 85.2% | 9 | 37.5% | 9/11 |
| No HTF confirm | 125 | — | 1 | 0.8% | 1/11 |

The exact A+ candidate—HTF confirm plus `vol_ratio >= 20`—reduced the primary
list from roughly 81 rows/day to roughly 12/day in this two-session sample,
while retaining 9 of the 11 large movers.

This is a strong direction signal, but it is in-sample and based on only two
sessions. It supports a reversible display experiment, not a detector or
Telegram rule change.

## Higher-timeframe breakdown

| Co-confirmed HTFs within ±2m | Rows | Reached +20% | Hit rate |
|---|---:|---:|---:|
| None | 125 | 1 | 0.8% |
| 15m only | 22 | 4 | 18.2% |
| 15m + 1h | 6 | 1 | 16.7% |
| 1h only | 3 | 2 | 66.7% |
| 15m + 1h + 4h | 2 | 0 | 0.0% |
| 1h + 4h | 2 | 2 | 100.0% |
| 15m + 4h | 1 | 1 | 100.0% |
| 4h only | 1 | 0 | 0.0% |

The 1h/4h cells look stronger than 15m-only, but their samples are tiny. The
UI may visually emphasize 1h/4h alignment, but the grading plan must retain
the exact timeframe combination rather than hard-code a 1h/4h gate now.

## Comparison with other candidate features

| Rule | Rows | Median 60m MFE | Reached +10% in 60m | Reached +20% in 240m | Fell −10% in 60m | Large runners retained |
|---|---:|---:|---:|---:|---:|---:|
| All | 162 | +1.1% | 9.3% | 6.8% | 8.6% | 11/11 |
| Volume `>=20x` | 63 | +2.1% | 20.6% | 14.3% | 11.1% | 9/11 |
| News available within 5m | 47 | +1.6% | 17.0% | 12.8% | 12.8% | 6/11 |
| Any HTF nomination/confirm | 44 | +1.9% | 25.0% | 22.7% | 15.9% | 10/11 |
| HTF + volume `>=20x` | 29 | +2.9% | 34.5% | 31.0% | 17.2% | 9/11 |
| HTF + `(news OR prior tick)` | 15 | +5.0% | 40.0% | 40.0% | 33.3% | 6/11 |
| HTF + `>=20x` + `(news OR tick)` | 12 | +17.7% | 50.0% | 50.0% | 33.3% | 6/11 |

### Interpretation

- **Multi-timeframe confirmation** provides the largest useful reduction while
  preserving the tail.
- **Volume ratio** is useful as a second-level ranking input, but `>=20x`
  alone still leaves too many rows.
- **News must remain a badge, not a gate.** Five of 11 large movers lacked a
  stored article within five minutes of the confirmation. CYCU demonstrates
  the timing problem: its reclaim preceded the Finviz fetch by about three
  minutes.
- **Tick evidence must remain a badge, not a gate.** It covered only three of
  the 11 large movers.
- Combining news/tick with HTF alignment increases apparent precision but
  loses nearly half the large-mover cohort and selects materially larger
  downside as well.
- Prior investigation showed absolute notional does not rank follow-through.
  It should not be used to optimize the list; FCUV and CYCU were both valid
  exceptional confirmations below the standard $10k floor.

## Named examples

### FCUV — A+ archetype

At 08:19:55 ET on 2026-07-31:

- 5m confirmed at $2.48, 31x sibling volume;
- 15m and 1h confirmed within approximately 11 seconds;
- a tick watch preceded the confirmation;
- the catalyst was already stored;
- confirmation was 7.4% above the original reclaim price;
- post-confirm MFE was approximately +310% in 60 minutes and +605% in the
  available 240-minute window.

This is exactly the multi-timeframe, extreme-expansion shape the priority list
should surface.

### CYCU — A+ even though news was late

At 08:20:37 ET on 2026-07-30:

- 5m and 1h confirmed together at $0.3656, 86.1x sibling volume;
- 4h confirmed seconds later;
- the $54.6M contract article was fetched roughly three minutes after the
  reclaim confirmation;
- confirmation was 6.5% above the reclaim price;
- post-confirm MFE was approximately +17.7% in 60 minutes and +176% in the
  available 240-minute window.

CYCU is why news should strengthen a row after arrival rather than be required
at the initial confirmation.

### DFNS — the deliberate miss risk

DFNS confirmed on 2026-07-29, before OHLC outcome instrumentation began:

- 5m-only confirmation at $29.45;
- 9.4x sibling volume and about $11k notional;
- no near-simultaneous HTF reclaim event;
- it was already heavily extended—about +83% at its first stored screen row.

DFNS cannot be included honestly in the two-session OHLC performance table.
It illustrates the cost of aggressive filtering: a 5m-only continuation can
still run. For that reason, B-tier rows should remain accessible rather than
being deleted or no longer computed.

## Entry-risk test

The optimized list is an **attention filter**, not an automatic entry signal.

For the 24 A+ candidates (`5m confirm + HTF confirm + vol_ratio >=20x`), using
5m high/low ordering over the available 240-minute window:

| Outcome | Rows |
|---|---:|
| Reached +20% before falling −5% | 4 |
| Fell −5% before reaching +20% | 11 |
| Reached neither | 9 |

When target and stop occur in the same 5m bar, the study conservatively counts
the stop first because tick-level ordering is unavailable.

The result means a fixed “buy the confirmation with a −5% stop” rule would
stop out many eventual winners. Multi-timeframe alignment improves selection,
but it also selects volatility and adverse excursion. Entry still requires a
separate risk-defined decision—such as a hold, controlled pullback, or reclaim
retest—and must not be implied by the A/A+ label.

## Proposed list design

### A+ — explosive-tail candidate

```text
5m reclaim confirmed
AND another timeframe reclaim confirmed within ±2 minutes
AND 5m confirmation vol_ratio >= 20x
```

Example display:

```text
A+  FCUV   5m✅ 15m✅ 1h✅ · 31x
A+  CYCU   5m✅ 1h✅ 4h✅  · 86x
```

### A — aligned candidate

```text
5m reclaim confirmed
AND another timeframe reclaim confirmed within ±2 minutes
```

This includes the lower-volume HTF-aligned population and preserves one more
of the 11 observed large movers.

### B — 5m-only candidate

```text
5m reclaim confirmed
AND no HTF reclaim confirmation within ±2 minutes
```

B rows continue to be detected, persisted, and graded. They should be
collapsed or visually dimmed by default, with an “All 5m” control that reveals
them immediately. This preserves DFNS/WETO-like exceptions and avoids
destroying the control population.

### Sorting within a tier

Proposed non-gating sort order:

1. 1h/4h co-confirmation present;
2. number of co-confirmed timeframes;
3. volume ratio;
4. fresh catalyst badge;
5. prior tick evidence;
6. newest confirmation first.

News, tick evidence, notional, staged arming, and float remain context—not
eligibility requirements—until larger samples demonstrate stable incremental
value.

## Implementation plan

### Phase 1 — reversible display-only experiment

Implement without changing tracker configuration, confirmation logic, event
persistence, or Telegram:

1. Build a per-ticker map of recently confirmed reclaim rows across all five
   timeframes.
2. For each confirmed 5m row, derive the HTF confirmations inside ±2 minutes.
3. Add payload fields such as:

   ```ts
   priority: 'A+' | 'A' | 'B'
   co_confirmed_tfs: Array<'15m' | '1h' | '4h' | '1d'>
   ```

4. Promote an existing 5m row when a qualifying HTF confirmation arrives up
   to two minutes later.
5. Render A+ and A first, with explicit timeframe badges.
6. Collapse B by default behind an “All 5m” control; persist the preference in
   the existing panel-layout settings.
7. Keep every B row in `tier_events` and the outcome cohort.

The display must not label A/A+ as “buy”, “high probability”, or “confirmed
winner.” Suggested language is “aligned” and “priority.”

### Phase 2 — preserve a reproducible grading cut

Add the cohort/rule and target-before-stop queries from this investigation to
`apps/api/scripts/research/reclaim-grading.sql` so subsequent checkpoints use
identical definitions.

At minimum, retain for each checkpoint:

- counts/day by A+/A/B;
- +10% within 60m and +20% within 240m;
- large-runner recall and precision;
- −5% and −10% adverse excursion;
- +20-before−5 ordering;
- session and exact HTF combination;
- standard vs exceptional confirmation;
- confirmation extension;
- news and tick overlap.

A stable `observation_id` remains desirable for exact event linkage, but the
display experiment can be derived from the existing event timestamps while
that instrumentation is pending.

### Phase 3 — out-of-sample checkpoint

Freeze the A+/A/B definitions for at least five additional sessions. Use ten
sessions for any alert or detector decision.

Questions for the checkpoint:

1. Does A retain at least roughly 70–80% of the +20% tail while materially
   reducing the list?
2. Does A+ remain more precise than A across multiple market regimes?
3. Does 1h/4h alignment remain stronger than 15m-only?
4. How often do A/A+ candidates hit −5% before their favorable excursion?
5. Is there an executable entry shape after confirmation that improves the
   target-before-stop ordering?
6. What is the cost of hiding B by default—how many DFNS/WETO-like winners
   occur there?

Only after that checkpoint should Telegram be reconsidered. Possible future
choices are:

- keep all current 5m Telegram confirms;
- alert A/A+ only;
- use different sounds for A+ and ordinary confirms.

No Telegram change is recommended from the current two-session sample.

## Explicit non-changes

This proposal does **not** change:

- EMA 10/65;
- reclaim arming or staged bars;
- volume confirmation ratios;
- the $10k standard floor or exceptional escape;
- observation duration or cooldown;
- higher-timeframe detection;
- Telegram eligibility;
- the known-runner universe;
- `tier_events` collection.

The goal is to improve the operator's attention allocation while preserving
the detector and its control population for honest grading.

## Decision

The data supports implementing A+/A/B as a reversible, display-only ranking.
It does not support deleting 5m-only reclaims or treating A+ as an entry rule.

The working interpretation is:

> A 5m reclaim becomes materially more interesting when another timeframe
> independently volume-confirms at the same moment. That alignment identifies
> most of the observed explosive tail, but it also carries large adverse
> movement and therefore ranks attention—not trade expectancy.

---

## Addendum — 3-session cross-validation and the B-notable amendment (2026-08-01, Claude)

The tier design above was validated on the full clean segment (2026-07-29
04:00 ET onward — one session more than the OHLC cohort, close-based outcome,
deduped to first confirm per ticker-day):

| Tier | n | Reached +20% same-day | Tail rate |
|---|---:|---:|---:|
| A+ (HTF co-confirm + `>=20x`) | 31 | 10 | **32.3%** |
| A (HTF co-confirm only) | 20 | 2 | 10.0% |
| B (5m only) | 169 | 6 | **3.6%** |

**Direction confirmed** — the 9× separation between A+ and B holds on the
wider window, and B's 3.6% sits at the measured random-bar null (2.5%).

**Recall corrected.** The 10/11 retention above is a two-day artifact: the
07-29 session (outside the OHLC window) contained at least five additional
large movers, and **none had an HTF co-confirm within ±2 minutes** — AMIX
(+59%), NUWE (+59%, 1h/4h only within ±30m), MF (+41%), PRCH (+25%), plus
**NCRA (+147% at 133× sibling volume with no HTF event at all)**. Full
3-session recall for A+/A is therefore **12 of 18 (67%)**, not 91%. This
lands at the low edge of the Phase-3 expectation (70–80%) and strengthens
the document's own design decision that B must remain accessible.

**Amendment shipped with Phase 1 — the B-notable band.** Confirmed 5m-only
rows with `vol_ratio >= 30` OR `price < $2` stay visible (the NCRA/WETO
band, from the independent price×ratio cell analysis); only B-rest collapses
behind the "show all" control. Visible-set recall on the 3-session window:
**14 of 18 (78%)** at roughly a 60% list reduction.

**One deviation from the proposed sort order:** rows keep newest-event-first
ordering with A+/A as *chips*, rather than tier-first ordering. Re-sorting
confirmed rows above fresh reclaims would re-create the 2026-07-28 starvation
bug (confirmed rows crowding out the early signal, the WLDS report) — the
triage comes from hiding the dead band and from the chips, not from burying
nominations.

**Also on the record:** DFNS's 5m confirm at $29.45 was **+197% into its
day** — the move preceded the signal, and post-confirm MFE was +3.6%. It is
not a filtering casualty; it was never a capturable EMA win. The day-change%
column shipped 2026-07-30 is the guard for that class.

Phase 2 is implemented: the exact A+/A/B-notable/B-rest cut is query 7 in
`apps/api/scripts/research/reclaim-grading.sql`.

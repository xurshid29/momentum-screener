# Reclaim-Only EMA 10/65 — Initial Production Investigation

**Investigation date:** 2026-07-30  
**Production snapshot:** 2026-07-30 09:28 UTC  
**Clean-segment cutoff used:** 2026-07-29 04:00 ET  
**Scope:** EMA 10/65 price-reclaim events in production `tier_events`

This is the first production-data review after the reclaim semantics stabilized.
It is a **direction check, not a keep/kill verdict**: the sample contains one
complete regular session plus the beginning of the next premarket. The layer
must remain configuration-stable for several more sessions before thresholds
are changed.

Related references:

- [`HANDOVER.md`](HANDOVER.md) — current operating state and semantics boundary
- [`detection-layers.md`](detection-layers.md) — reclaim mechanics and grading fields
- [`web-dashboard.md`](web-dashboard.md) — dashboard history and strategy status

## Executive conclusion

Keep the reclaim layer running, but continue treating a 5m confirm as an
**inspect-now alert**, not a proven automatic entry.

The layer is detecting genuine right-tail runners, but the median regular-hours
5m confirmation did not show enough immediate follow-through in this initial
sample. Volume confirmation proves that activity arrived; it has not yet proved
that sufficient tradable upside remains after the alert.

Do not currently:

- change EMA 10/65;
- reduce or remove staged arming;
- lower the standard $10k confirmation floor;
- promote the exceptional-volume escape or higher timeframes to Telegram;
- add an “about to confirm” predictor.

The highest-value next work is better outcome instrumentation: link each
nomination to its terminal event, persist OHLC rather than close-only bars, and
grade explicit stop/target rules.

## Data source and method

The investigation queried the production Postgres database read-only through
the production container:

```bash
ssh root@165.245.210.95 \
  "cd /root/projects/pnldash && \
   docker compose -f docker-compose.prod.yml exec -T postgres \
   psql -U pnldash -d pnldash"
```

Reclaim events were selected with:

```sql
WHERE tier = 'cross'
  AND meta->>'signal' = 'reclaim'
  AND at >= timestamptz '2026-07-29 04:00:00-04'
```

The cutoff deliberately starts at the 04:00 ET trading-day boundary. Older
events were excluded because reclaim semantics changed repeatedly through
2026-07-28.

Short-horizon outcomes joined each 5m confirmation to `bars_5m` closes from the
confirmation timestamp through the following 30 or 60 minutes. Confirmations
less than 65 minutes old were excluded.

Important limitation: `bars_5m` currently persists only `close` and `volume`.
The reported maximum favorable excursion (MFE) and maximum adverse excursion
(MAE) are therefore based on 5-minute closes, not true intrabar highs/lows.

## Clean-period event volume

| Timeframe | Nominations | Confirms | Expires | Distinct confirmed tickers |
|---|---:|---:|---:|---:|
| 5m | 1,027 | 112 | 547 | 99 |
| 15m | 656 | 75 | 184 | 72 |
| 1h | 318 | 51 | 3 | 48 |
| 4h | 117 | 64 | 0 | 47 |
| 1d | 110 | 8 | 0 | 5 |

These raw counts are transitions, not perfectly matched observations. Higher
timeframes also have longer observation lifecycles, so their low expiry counts
must not be interpreted as high precision.

The 5m volume was not solely a boot/reseed burst. Nominations were distributed
through the July 29 session and peaked around 14:00–15:00 ET. The layer is
genuinely producing a broad nomination funnel.

## 5m funnel by arming and evidence shape

This cut included 5m nominations at least 40 minutes old. A terminal event was
matched only when a confirm/expire occurred before the ticker's next 5m
nomination.

| Arming | Path | Baseline | Nominations | Confirms | Expires | Unresolved | Confirm % of terminal |
|---|---|---|---:|---:|---:|---:|---:|
| Same-bar | Direct | Dead baseline `<$2k` | 313 | 25 | 143 | 145 | 14.9% |
| Same-bar | Pending | Dead baseline `<$2k` | 206 | 15 | 106 | 85 | 12.4% |
| Same-bar | Direct | Baseline `≥$2k` | 193 | 21 | 92 | 80 | 18.6% |
| Staged | Direct | Dead baseline `<$2k` | 188 | 10 | 136 | 42 | 6.8% |
| Staged | Direct | Baseline `≥$2k` | 116 | 24 | 66 | 26 | 26.7% |
| Same-bar | Pending | Baseline `≥$2k` | 9 | 1 | 4 | 4 | 20.0% |

“Dead baseline” means:

```sql
(meta->>'sib_median')::numeric
  * (meta->>'cross_price')::numeric < 2000
```

The unresolved column is expected to be large on sparse names: the observation
window advances on actual bars, not wall-clock minutes.

### Initial interpretation

Staged arming is **not** the obvious source of the funnel's noise. In the
non-dead baseline band, staged observations had the strongest terminal
confirmation rate in this first sample. This does not yet prove better returns,
but it argues against reducing `staged_arm_bars` now.

The weak cell is staged arming over a dead baseline. It may eventually justify
a conditional evidence floor, but the current sample is not sufficient to
remove those nominations—the dead-baseline population still produced some
right-tail moves.

## 5m post-confirm follow-through

There were 112 confirmations old enough for a 60-minute evaluation. One hundred
had usable persisted bars.

| Metric | Result |
|---|---:|
| Average 30m close-based MFE | +2.38% |
| Median 30m close-based MFE | +0.38% |
| Average 30m close-based MAE | −1.62% |
| Median 30m close-based MAE | −1.20% |
| Average 60m close-based MFE | +3.70% |
| Median 60m close-based MFE | +0.62% |
| Reached +5% within 30m | 11 / 100 |
| Fell at least −3% within 30m | 18 / 100 |

The difference between mean and median shows the layer's current character:
the average is lifted by a small number of large runners, while the typical
confirmation has little immediate upside.

That may still fit a low-float strategy if losses are cut tightly and the right
tail is retained, but the database cannot yet test that strategy honestly
because it lacks bar highs/lows and explicit stop/target outcome records.

## Follow-through by reclaim path

| Arming/path | Confirms | With 60m bars | Median 60m MFE | Median 60m MAE | Hit +5% |
|---|---:|---:|---:|---:|---:|
| Same-bar, direct | 58 | 49 | +0.72% | −1.74% | 5 |
| Staged, direct | 35 | 33 | +0.40% | −1.65% | 3 |
| Same-bar, pending | 19 | 18 | +2.26% | −2.51% | 5 |

Pending conversions show more upside and more downside. They are a plausible
high-volatility cohort, not yet a high-confidence cohort.

Staged confirmations had slightly weaker median MFE than same-bar confirms, but
the difference is small and comes from one session. Combined with the stronger
non-dead-baseline funnel rate, there is no current case for removing staged
arming.

## Liquidity and exceptional-volume cuts

| Confirmation band | Confirms | With 60m bars | Median 60m MFE | Median 60m MAE | Hit +5% |
|---|---:|---:|---:|---:|---:|
| Dead baseline `<$2k` | 49 | 47 | +0.39% | −2.13% | 8 |
| Standard notional `$10k–25k` | 26 | 22 | +0.62% | −2.17% | 1 |
| Standard notional `$25k+` | 30 | 25 | +0.38% | −1.57% | 2 |
| Exceptional escape `<$10k` | 7 | 6 | +3.81% | −6.26% | 2 |

The GSUN-style exceptional escape is behaving like a high-variance tail
detector: better median upside in a tiny sample, but much worse adverse
excursion. Keeping it dashboard-and-grading-only is the correct posture.

Higher absolute notional did not rank follow-through in this first session.
That is a warning against assuming that simply raising the $10k floor will
improve precision.

## Tick-ladder overlap

Only eight 5m confirmations had a preceding `tick` watch/confirm within two
hours:

| Reclaim timing | Cases | Median 60m MFE | Median 60m MAE | Hit +5% |
|---|---:|---:|---:|---:|
| Later-bar confirm after tick evidence | 5 | +10.69% | −6.25% | 4 |
| Instant confirm after tick evidence | 3 | +14.52% | −1.71% | 2 |

The other 104 confirmations had no prior tick event and substantially weaker
median follow-through.

This is promising but severely under-sampled. A preceding tick event should be
recorded and displayed as a **confluence tag**, not made a required gate. A
hard requirement could delete the slow-curl cases that the reclaim layer is
supposed to find before the +10% tick threshold.

## Session cut

| Session | Confirms | With 60m bars | Median 60m MFE | Median 60m MAE | Hit +5% |
|---|---:|---:|---:|---:|---:|
| Premarket | 7 | 7 | +5.49% | −4.90% | 4 |
| Regular | 101 | 89 | +0.56% | −1.71% | 7 |
| After-hours | 4 | 4 | +4.49% | −6.98% | 2 |

Premarket and after-hours contain the stronger tails, but the samples are only
7 and 4. They also carry materially worse adverse movement. No session alert
gate should be changed from these counts.

The regular-hours result is the main concern: the typical confirmation showed
little remaining upside. Several more independent sessions are required to
separate a weak market day from a weak confirmation rule.

## Recommended improvements

### 1. Freeze semantics while the clean cohort grows

Hold EMA lengths, staged arming, nomination floors, confirmation ratios, and
observation windows constant for at least several full sessions. Repeated
threshold changes reset the usable grading segment and encourage anecdotal
overfitting.

### 2. Persist one reclaim observation as one durable entity

`tier_events` records transitions but has no stable observation identifier.
Matching nominate → confirm/expire currently requires temporal inference and
becomes ambiguous when a ticker re-arms.

Add either:

- a `reclaim_observations` table with one row per nomination; or
- an `observation_id` carried by all related `tier_events`.

Minimum durable fields:

- ticker, timeframe, trading day;
- nomination, confirmation, expiry timestamps and prices;
- intrabar, staged, pending, and `in_ladder`;
- sibling median, baseline dollars, notional, volume ratio;
- catalyst state and tick-ladder overlap;
- terminal reason and peak telemetry.

The existing `screener_outcomes` uniqueness of `(screen, ticker, et_date)` is
not sufficient because reclaim observations can recur for one ticker/day.

### 3. Persist OHLC for grading

Extend `bars_5m` to retain at least `high` and `low` alongside `close` and
`volume`. Close-only MFE/MAE can miss both the achievable target and the stop
violation inside a bar.

OHLC is required to test:

- reclaim-bar-low stop;
- EMA65 invalidation;
- fixed −2% / −3% stops;
- +3%, +5%, +10%, 1R, and 2R targets;
- which occurred first: target or stop.

### 4. Grade trading utility, not confirmation rate alone

For every confirmed observation, compute:

- 5m, 15m, 30m, 60m, and end-of-day MFE/MAE;
- time to peak and time to invalidation;
- target-before-stop results;
- extension already paid between nomination and confirmation;
- session, price, float, catalyst, and shelf cohorts.

The decision metric for Telegram should be remaining risk-adjusted opportunity
after the alert, not nominate-to-confirm conversion.

### 5. Grade tick confluence without making it mandatory

Record whether `tick` watch/confirm occurred:

- before the reclaim nomination;
- between nomination and confirmation;
- after the reclaim confirmation;
- not at all.

If the initial confluence advantage survives several sessions, add a visible
`↗ + 👀` confidence marker or a separate ranked cohort. Do not make it a hard
gate until the reclaim-only slow-curl population is compared directly.

### 6. Preserve current alert restraint

- Telegram: confirmed 5m standard path only.
- Exceptional `<$10k`: dashboard and grading only.
- 15m/1h/4h/1d: dashboard and grading only.
- `◆ moving`: descriptive only.

No current result supports expanding the phone-alert surface.

## Decision checkpoint

Re-run this investigation after at least three full clean sessions for a
direction check and after roughly ten sessions for threshold decisions.

At the next checkpoint, answer:

1. Does regular-hours median post-confirm MFE improve beyond its current
   +0.56%?
2. Does staged arming retain its stronger non-dead-baseline funnel rate?
3. Does pending conversion retain higher upside after controlling for MAE?
4. Does tick/reclaim confluence remain materially stronger with a larger `n`?
5. Do exceptional-volume escapes earn Telegram promotion under a
   target-before-stop test?
6. Does any price, baseline-dollar, session, or catalyst band produce stable
   risk-adjusted separation?

Until then, the correct interpretation is:

> The reclaim layer is a broad nominator with real right-tail catches. Its
> current 5m volume confirmation is useful for attention, but one clean
> session does not yet establish a standalone entry edge.

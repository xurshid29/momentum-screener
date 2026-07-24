# The Early-Detection Layers — reference (current as of 2026-07-15)

The dashboard detects runners through a chain of layers, ordered by how early
they can speak. Each was measured before (or while) shipping, each is graded
continuously via the `tier_events` table, and each survives deploys. This doc
is the *how-it-works* reference; `docs/HANDOVER.md` carries what changed
lately, `docs/web-dashboard.md` the full history.

```
📰 news radar        catalyst lands, price hasn't moved      (minutes–hours early)
🤫 quiet accum       volume arrives, price still <10%        (minutes–hours early)
📈 EMA cross         price curls on 5m bars, volume confirms (minutes early; TRIAL)
👀 tick watch        +10% cross on the per-second tape       (seconds into the move)
🛰️ tick confirm      volume proves the move                  (the conviction ping)
⚡ screens           Finviz momentum / ignition / swing      (the established layer)
```

Which layer speaks first depends on the **move shape**:

| Move shape | First responder |
|---|---|
| News published before any move | 📰 radar |
| Volume builds while price sits flat | 🤫 accum |
| Slow curl over tens of minutes | 📈 EMA cross (and 🤫) |
| Vertical ignition (seconds–minutes) | 👀 watch → 🛰️ confirm |
| Anything that sustains | ⚡ screens (+ runner score, alerts) |

---

## Shared infrastructure

**Tick feed** (`tickfeed.ts` + `sidecar/tickfeed.py` + `tick-detect.ts`).
Databento EQUS.MINI per-second OHLCV over one live session (Standard plan,
$199/mo flat, $0 metered; the only hard limit is ONE concurrent connection —
the sidecar releases its slot on SIGTERM and backs off on the limit error).
Subscribed universe = the **union of both screens' structural bands**: the
momentum filter minus its momentum sub-filters, ∪ the ignition filter's band
(`ind_stocksonly,sh_price_u10`) — ~3,500–4,000 symbols, refreshed every 10 min
(two Finviz exports, 1.3s apart). Without the union, a sub-$1 runner is
invisible to the per-second layers until a screen catches it mid-flight (the
TGHL case). Additional additive subscriptions: current screen rows every 30s
(prior close derived from the row in PM/REG, from `daily_bars` in AH — the UPC
case), and news-radar names (prior close from `daily_bars`).
⚠️ MINI is a fraction of consolidated tape — all $-notional knobs are
*feed-visible* dollars.

**tier_events** (`tier-events.ts`, table `tier_events`). Every layer
transition is inserted fire-and-forget (never blocks a cycle):
`accum` flag/promote/expire · `tick` watch/watch_suppressed/confirm/fade/
watch_expired · `radar` hit/moving/expired/dropped · `cross`
nominate/confirm/expire — each with a meta jsonb (chg, rel_vol, mom, via, pts,
minutes, impact, reason, source…). Grading is SQL over any date range; docker
logs reset on every deploy, this doesn't.

**seedTierState** (poller, boot). Replays today's tier_events in order to
rebuild the LIVE TICKS ladder, radar entries, confirmed crosses, and every
once-per-day dedup set — deploys don't blank the sidebar or re-ping names.
Reseeded *observing* crosses are dropped (their observation died with the old
process); detector baselines rebuild live in ~1–2 min.

**bars_5m + backfill** (table `bars_5m`, logic in `tickfeed.ts`). Every LIVE
closed 5m bar for known runners persists (batched, 3-day retention, pruned at
midnight). Boot replays 48h through the EMA tracker (silent — history can't
nominate). Known runners still below ~50 banked bars get historical 5m bars
(once/symbol/ET-day, re-scanned every 4h): **Databento historical** first
(batched ~100 symbols/request, same MINI scale as the live stream — no
volume-scale skew; metered but cents), **Yahoo** as the per-symbol fallback
for names too thin to print on MINI. Closes seed the tracker only while the
symbol has produced no live bar. Net effect: the EMA layer is always warm.
The Yahoo path's volumes are consolidated-scale — ratios read LOW until the
sibling window self-heals (~1h of live tape); the confirm notional floor
covers the thin-tape residual.

**News-day semantics.** "Today's news" rolls at **04:00 ET** (premarket
start), not midnight — the closed session belongs to the finished trading day,
matching the change% column (the VRAX 🔥-cliff fix). Alert dedups and per-day
trading state stay midnight-anchored.

**Known runners** = every ticker seen on momentum/ignition in the last 30 days
(`radarHistory`: DB-seeded at boot, grown live; ~1,500). Scopes the radar and
the EMA layer.

---

## 📰 News radar (`poller.ts`: NEWS_RADAR, updateNewsRadar)

**What/why.** A fresh bullish catalyst on a known runner that is NOT on any
screen yet. Measured: when a headline precedes a detection, the move starts
minutes later (median news→detection lag 7.9 min, p75 91); entering on the
news beats entering at our detection ~2× on peak capture (EMAMACD2 study).

**How.** The Benzinga delta the poller already pulls every 20s is market-wide
(paginated ≤3×100/cycle); fresh articles + news-type halts (T1/T2/T12 only —
LULD pauses are mid-move mechanics, filtered out) are matched against known
runners not currently screening. Hits classify through the shared URL cache
(rules now, LLM refinement upgrades in place; a bearish flip drops the entry).
Entry TTL 90 min; escalates to **moving ↗** when the tick detector
(watch/confirmed only) or a screen picks the name up. Radar names are armed
into the tick feed so the per-second ladder is listening before the move.

**Surfacing.** Purple 📰 sidebar section + soft ping per hit; Telegram only
for strong/major urgency, once/ticker/day. Benzinga's multi-ticker
"why is it moving" blurbs carry one representative ticker's quote-page URL —
single-ticker news lists rewrite `/quote/<sym>` to the viewed ticker.

**Grading.** `tier='radar'`: hit → moving (via, minutes) vs expired
(outcome moved/no_move). Knobs: `NEWS_RADAR` (history_days 30, ttl_min 90,
max_display 12).

---

## 🤫 Quiet accumulation (two sources, one ladder state)

**What/why.** Volume arrives before price — the real carrier behind the
operator's recurring EMA/MACD chart instinct. Measured (55d cohort): quiet
names (chg<10%) with fast RVol ≥10× go on to ≥+20pt moves 20–25% (AH) /
12–14% (PM/REG) vs ~3% without volume; **persistence is THE discriminator**
(hot ≥3 cycles: 65% promote / 24% big-move vs 35%/7% transient).

**Screen-side** (`poller.ts`: ACCUM, scanAccumulation): a screened row within
its first 10 min on screen, chg 0–10%, `max(rv1m, rv5m) ≥ 1000%`, sustained
across ≥3 poll cycles. Once/ticker/day.

**Detector-side** (`tick-detect.ts`: TICK_DETECT.accum_*): for names the
screens can't see (the SLS case — day-RVol never cleared momentum's Finviz
gate). Cum ∈ [3%, 10%) AND trailing 60s volume ≥3× the symbol's own quiet
baseline, sustained 120s, junk floor + near-high. The quiet baseline excludes
surge windows (an accumulation burst must not pollute its own reference).

**Lifecycle.** Teal 🤫 row in LIVE TICKS, TTL 120 min (measured: when these
resolve, they usually cross +10% in 1–17 min; only ~3–6% after 2h). Promotes
to 👀 via the detector's watch event (suppression bypassed — the tier already
vetted it) or a screen backstop at +10%; confirms via the normal 🛰️ paths.

**Surfacing.** Quietest ping in the set per flag; Telegram ONLY for sustained
accumulation + a bullish catalyst (the highest-conviction slice: 72% promote /
30% ≥+20pts, ~1.6/day). Raw fastRV magnitude does NOT rank winners (measured —
the old ≥3000% push gate was backwards and is retired).

**Grading.** `tier='accum'`: flag (meta.source 'screen'|'tick', fast_rv/chg) →
promote (via, minutes, pts) vs expire (peak_pts).

---

## 📈 EMA-cross layer (`ema-cross.ts`; **TRIAL**)

**What/why.** The operator's manual TV loop, automated: an EMA bullish
crossover — **10/65 since 2026-07-22** (6/50 at launch; ⚠️ a different
signal — segment ALL cross grading at that date, every timeframe) — on
5-minute bars **nominates** a known runner; volume expansion vs
its sibling candles **confirms**. Both prior studies say the cross alone has
zero selection power (≈0.9× random; +0.0pts paired as an entry trigger) — so
it is strictly a nominator; the volume stage carries the precision.

**How.** Per-second bars aggregate into 5m buckets (bar closes when a trade
arrives in a later bucket — TV-like on thin tapes). EMAs are SMA-seeded;
crosses count only after 50 closed bars (warmup — solved by bars_5m replay +
historical backfill, see shared infra). On a cross (`prevDiff ≤ 0 && diff >
0`, sibling median ≥50 sh): if the cross bar itself runs ≥5× the sibling
median → instant confirm; else observe 6 bars (~30 min) — confirm on any
closed bar with volume ≥3× the anchored sibling median AND close ≥ cross ×
1.005. Every confirm path also needs ≥$10k on the confirming bar
(`confirm_min_notional`, feed-visible $ — the sibling floor is 50 SHARES, so
a dead-tape "3×" can be a few hundred dollars; an instant-confirm that fails
it demotes to a normal nomination). Nominations need ≥$2k of bucket/bar
dollars (`nominate_min_notional`, 2026-07-22 — the LBTYK phantom: a lone
1-share odd-lot print at +10% "crossed" our MINI-fed EMAs; the SIP tape
excludes odd lots so TV never saw the trade — the floor is TV-parity, and
intrabar rejection consumes no state, so real bursts fire seconds later).
**Stale-EMA guard** (`stale_gap_bars`, same day — the SKYQ case): a thin name
silent on OUR feed for >3 intervals of in-session time can't nominate
intrabar off its frozen EMAs (TV's cross happened hours earlier on the
consolidated tape) — the resume bucket must close first, so the nomination
comes ≤1 bar late with fresh prices committed; session-open resumes are
exempt (overnight gaps are symmetric across feeds). No expansion → silent expire (peak
telemetry). **Re-fire rules (2026-07-16):** a confirm ends the symbol's day;
an expired observation re-arms after a cooldown
(`renominate_cooldown_sec` — the TGHL lesson: a weak 0.4× morning cross must
not lock out the real 6.7× afternoon one). 5m cooldown 60→**30 min**
(2026-07-22): measured — late rallies re-cross a median ~4.5h after the dud
cross and the re-arm path carries 27% of 5m confirms, so the observation
window stays 30 min and the lock got tighter instead (1h/4h cooldowns
unchanged: 2 bars / 1 bar).
**Intrabar detection (2026-07-16, the DXST/EHGO lag report):** TV alerts
evaluate the cross on the LIVE forming bar (the operator's alerts fired
42–75s into the bar; bar-close-only evaluation was ~4–5 min behind). Every
tick now also runs a provisional check — EMAs folded forward with the live
price, confirms allowed mid-bar on the bucket's ACCUMULATED volume (monotone,
so anything clearing a threshold mid-bar also clears it at close; the
mid-bar cross bar keeps the 5× instant rule, later bars the 3× rule, floors
unchanged). Events carry `intrabar` in meta — grade the latency win and the
wiggle-nomination cost separately. Kill switch: `EMA_CROSS.intrabar_detect`.
Residual quantization caveat: a pure gap (no preparatory bar) still crosses
late; a move with a preparatory bar (TGHL) crosses at that bar — now at the
moment the provisional EMAs touch, not its close.
**Gap-decay + sparse re-seed (2026-07-23, the CPHI lesson — the thin-tape
horizon fix).** The MINI subset tape leaves the median known runner at ~33
five-minute bars/day (vs ~192 ETH buckets; 81% of tracked names < 55/day) —
so "65 bars" of slow EMA reached back DAYS while TV's spans hours. CPHI: our
EMA65 sat at $1.88 (still remembering Monday's $2.20 tape) vs TV's $1.74 off
the recent flat-line → our cross fired 09:50 ET at $2.04, TV's at ~09:35 —
15 min late at the top of the move. Three mechanisms, all shipped together:
(1) **gap-decay** (`gap_decay`, all timeframes): every empty IN-SESSION
bucket decays the EMAs toward the last close exactly as if a flat
carry-forward bar had printed — applied lazily in closed form, no timers/
synthetic bars; nights and weekends decay nothing (TV holds EMAs across the
close); warmup counting, sibling volumes and persistence see only real bars;
a fast-over-slow flip DURING a gap parks a PENDING quiet-curl cross at the
carry price (the ZBAO mechanism reused). (2) **Thin-sibling pend**: a
real-dollar cross over a dead sibling window (median < 50 sh — on sparse
names the "prior hour" of siblings spans days of junk prints) used to be
consumed SILENTLY by the floor; it now pends, and **pendings convert
INTRABAR** the moment bucket dollars accumulate (same monotone-volume
soundness as intrabar confirms; conversion is gated on the provisional diff
so a crashing tick can't convert a dying cross). (3) **Warm-but-sparse
consolidated re-seed**: the Yahoo 5m fallback used to rescue only
below-warmup names; now names past warmup but under `SPARSE_5M_MIN_BARS_24H`
(120 banked bars in the last 24h) get their EMA state rebuilt from Yahoo's
consolidated tape (`reseedFromHistory` — refuses mid-observation, keeps day
flags and the feed-scale sibling ring), **retried every 2h intraday**
(same-day follow-up, the RELL/LFMD lesson: with a once/day re-anchor the
path divergence re-accumulated within hours — RELL re-fired a morning TV
cross as "fresh", LFMD crossed while TV's fast sat 3% below its slow),
most-recently-active first, capped per scan, and deliberately NOT persisted
to bars_5m (persisted Yahoo bars made swept names read "dense" and excluded
them from later sweeps); the HTF backfill's Yahoo path gained the same warm
re-seed (CPHI's 1h EMA65 read 2.73 vs fast 1.92 off a weeks-deep MINI
horizon). Known transient: a deploy boot re-derives every symbol's EMAs, so
the first minutes can burst nominations (fresh-eyes re-evaluation — 8 of 10
sidebar rows fired ≤8 min after the 07-23 boot); one-time per deploy. Replayed on
CPHI's real banked bars: nominate 09:35 at $1.73 + confirm 09:40 intrabar —
vs the live 09:50:53/$2.04 — matching the operator's TV alert. Verified:
S22–S26 (decay parity vs flat fill, in-gap flip pending, out-of-session
no-decay, dead-sibling pend/convert, warm re-seed). ⚠️ Grading: cross
semantics changed AGAIN — the clean 10/65 segment now starts **2026-07-24**.

**Price-reclaim channel ↗ (2026-07-24, operator's ask — the TV alert form's
"price Crossing Up EMA(10) AND price Crossing Up EMA(65)").** A single bar
punching up through the whole EMA stack, run as a PARALLEL nomination
channel next to the crossover — measured first (4d of banked bars): only
11% of reclaim bars coincide with a crossover bar (~1.6× the raw rate), so
it's a genuinely different event set — the early precursor before the
crossover, the pullback-reclaim after it. Detection: previous CLOSED bar's
close at/below BOTH EMAs, current price above both (intrabar equivalence:
price above the provisionally-folded EMA ⟺ above the committed one, so the
committed values compare directly). Fully separate observation state
(`watchR`/`confirmedTodayR`/`lockedUntilR`) so the two funnels never gate
each other; same volume-confirm rules, junk floor, stale guard; thin
sibling windows skip (the reclaim re-arms on the next dip-below-both cycle
— no pend needed). Events carry `signal: 'reclaim'` (queued via
`drainEvents()`, never the cross channel's return value) → tier_events
`meta.signal` is the A/B grading cut: nominate→confirm rate + forward
outcomes per channel, decided by data. Kill switch `reclaim_detect` — 5m
only for the trial (HTF configs off until the A/B earns scope). Alerts:
own slug `ema_reclaim` (mutable independently of `ema_cross`); Telegram
headline "↗✅ PRICE RECLAIMED EMA 10+65"; sidebar rows carry a blue ↗ tag
and read "reclaim Xm ago" — they will NOT match TV crossover alerts by
design, they match the price-crossing alert pair. Scenarios S27–S28.

**Surfacing.** Green 📈 sidebar section: dim "…observing" → "✅ N× vol" with a
soft ping on confirm only. Timestamps are bar-close times; "ago" anchors on
the cross (matches the TV chart). Names already in the LIVE TICKS ladder skip
display (logged `in_ladder`). No Telegram until graded. **News support
(2026-07-22):** every cross row is enriched async with the news day's
freshest article + classification (🔥 CatalystBadge, click → news modal).
Most cross tickers aren't screening, so the lookup goes DB-first (the
market-wide Benzinga sweep + radar land articles there) with the on-demand
per-ticker top-up (`fetchAndStoreTickerNews`) as fallback; cached per
ticker/news-day (`crossNewsCache`), applied to all of a ticker's live rows
across timeframes. Grading side: join `tier_events` to `news_articles` on
(ticker, day) — catalyst-vs-no-catalyst crosses is a first-class cut.

**Timeframe layers (configurable, 2026-07-21).** The tracker is config-driven
(`EmaCrossConfig`); live layers: **5m** (bespoke — 48h bars_5m replay covers
its warmup, Yahoo fallback) plus the **HTF list** in `tickfeed.ts`
(`htfLayers`): **1h** (`EMA_CROSS_1H`, bars_1h, 30d backfill / 35d retention)
and **4h** (`EMA_CROSS_4H`, bars_4h, 120d/130d). Adding/removing an interval
= one `makeHtfLayer` entry + its bars_* migration; boot seed, live feed,
persistence, retention, backfill and /health all loop the list. The UI shows
one section per timeframe (📈 EMA 5M / 1H / 4H), payload capped per tf.
**Live-state audit tool:** `GET /api/screener/ema-debug?ticker=X` returns
every layer's current EMA6/EMA50/bar-count/sibling-median for that symbol —
compare against the TV chart whenever a detection looks off (the WOK class).
A golden-reference test (S14) pins the EMA math to an independent
implementation exactly.
4h buckets anchor to the ET session
grid (04:00/08:00/12:00/16:00 ET — TV's ETH 4h bars; EDT offset 0, EST 3600,
recomputed at midnight); 1h buckets are hour-aligned everywhere. The operator keeps the entry filter and the exit —
this layer is a pure detection tool: intrabar nomination the second the 4h
cross happens, **dashboard-only** (4H badge in the EMA CROSS section, rows
linger 6h; no Telegram, no ping) until tier_events (`meta.tf='4h'`) shows the
real fire rate. Warmup needs ~50 closed 4h bars ≈ 2–3 weeks — impossible
live, so `bars_4h` (130d retention) + a Databento ohlcv-1h backfill (120d,
batched, ET-aligned aggregation, no Yahoo fallback) are load-bearing.
⚠️ **Depth ≥ warmup (the WOK lesson, day-1):** a 4h EMA50 spans ~5 weeks,
so the original 35d backfill left our EMA50 at the recent flat average
(WOK: ours 2.02 vs TV's 2.63 after the collapse) and a $2.04 uptick
"crossed" — TV-parity needs ~150 bars (~2% residual seed influence), hence
the 120d depth. ⚠️ **And splits (same day):** TV history is split-adjusted,
Databento raw — a reverse split inside the seed window breaks the EMA scale
(WOK 1:78 on Jun 18). `adjustSplitHistory` fixes it read-side at seed time
(overnight up-jumps ≥4.85×, or 1.94–4.85× within 2.5% of a whole number;
down-moves are never splits — real crashes stay). Applied to both layers'
boot replay + the 4h backfill; the DB keeps raw truth.
Context: cross-as-signal was twice measured at chance on 30m/1h — the
operator's edge claim here lives in their manual filter + tight-stop
management, explicitly their department; grade the layer on lead time and
fire rate, not precision.

**Status.** TRIAL — keep/kill by the grading pass (~07-17+). Day-1 (07-14):
37 nominations → 13 confirms / 14 expires — but those numbers predate the
07-16 semantics (cooldown re-arm means several nominate→expire cycles per
ticker/day are legitimate; the notional floor prunes dead-tape confirms), so
**segment grading at 07-16 and count the funnel per observation, not per
ticker**. 07-15 was a blind day (warmup); full infrastructure (coverage +
persistence + backfill) only since 07-16. Meta now records `vol`,
`sib_median`, `notional` on nominate/confirm (and `sib_median` on expire, so
`peak_ratio` converts to absolute shares) — recalibrate `confirm_min_notional`
from these. Synthetic regression: `npx tsx scripts/verify-ema-cross.ts`.
Knobs: `EMA_CROSS`. Grading: `tier='cross'`.

---

## 👀 Tick watch → 🛰️ confirm (`tick-detect.ts` + poller `onTickEvent`)

**What/why.** The per-second early-ignition ladder. Single-shot relvol
detection was structurally late on nano-caps (catches at +23–63%: gappers had
no baseline; relvol clears 20–30pts after price; slow grinders never trip the
momentum gate) — so price flags first, volume confirms second.

**👀 Watch.** Fires when cum (vs prior close) crosses +10% (≤100%), near the
window high, over a junk floor (≥5 prints & ≥$2k/2min feed-visible). Gates in
the poller: **evidence at the cross** — rel_vol ≥3× own quiet baseline OR
momentum ≥3%/60s (drift-crossers like VSTM/ADCT grinding to +10% over hours
fail both and are suppressed; confirm paths stay live); **staleness** — a
first-sight-already-above-the-line name that's already on a screen is old news
(suppressed; boot-time "screens unknown" counts as screened). Fresh crosses
alert even on-screen (a catalyst-less screen row generates no push — the AUID
case). Telegram 👀 + soft ping, once/ticker/day.

**🛰️ Confirm** — any of three paths, once/ticker/day: the validated **surge**
rule (relvol ≥5× quiet baseline + cum ≥12 + mom ≥8%/60s + near-high); the
baseline-free **sustain** read (age ≥2min + extended ≥3pts + holding ≥ flag
price + ≥$25k feed-visible since flag; express lane: 30s if extension ≥20pts —
the CETX fix); or a **screen** returning the name (only counts when the screen
did NOT already hold it at watch time). Telegram 🛰️ + radar ping.

**Fade/expiry.** Watch fades on 60% giveback or 15-min TTL (both logged);
faded names can resurrect only via the surge rule. In AH, LIVE TICKS rows
refresh price only (row change% is AH-anchored; the ⚑ flag is prior-day
anchored — the UPC display fix).

**Grading.** `tier='tick'`: watch / watch_suppressed (reason
low_evidence|stale_*) / confirm (via) / fade / watch_expired. Knobs:
`TICK_DETECT`, `TICK_WATCH_EVIDENCE` (poller).

---

## ⚡ Screens (the established layer — pointers only)

Momentum (change+relvol gated), Ignition (volume-led sub-$10, runner_score,
alert ≥65 or premium catalyst), Swing (v2, alert ≥60), Faders/continuation,
fresh-burst 🚀, new-ignition 🆕, outcome tracking (`screener_outcomes`),
burned ⛔ / hype 🚀 markers. See `CLAUDE.md` + `docs/web-dashboard.md` +
`docs/ignition-screener-spec.md`.

---

## The grading playbook (run after ≥3 full sessions)

```sql
-- accum precision, by source and volume band
SELECT meta->>'source' src, count(*) FILTER (WHERE event='flag') flags,
       count(*) FILTER (WHERE event='promote') promotes,
       count(*) FILTER (WHERE event='expire') expires
FROM tier_events WHERE tier='accum' GROUP BY 1;

-- evidence-gate cost: suppressed watches that later confirmed
SELECT s.ticker, s.at, c.at FROM tier_events s
JOIN tier_events c ON c.ticker=s.ticker AND c.tier='tick' AND c.event='confirm'
  AND c.at BETWEEN s.at AND s.at + interval '2 hours'
WHERE s.tier='tick' AND s.event='watch_suppressed'
  AND s.meta->>'reason'='low_evidence';

-- cross-layer funnel + whether confirms led anywhere (join screener peaks)
SELECT event, count(*) FROM tier_events WHERE tier='cross' GROUP BY 1;

-- radar precision by catalyst type
SELECT meta->>'type', count(*) FILTER (WHERE event='moving') moved,
       count(*) FILTER (WHERE event='expired' AND meta->>'outcome'='no_move') dead
FROM tier_events WHERE tier='radar' GROUP BY 1;
```

Keep/kill standard: a layer earns its Telegram push (or retirement) from these
numbers, never from anecdotes — the same bar every shipped layer has passed.

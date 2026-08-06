# The Early-Detection Layers — reference (current as of 2026-08-06)

The dashboard detects runners through a chain of layers, ordered by how early
they can speak. Each was measured before (or while) shipping, each is graded
continuously via the `tier_events` table, and each survives deploys. This doc
is the *how-it-works* reference; `docs/HANDOVER.md` carries what changed
lately, `docs/web-dashboard.md` the full history.

```
📰 news radar        catalyst lands, price hasn't moved      (minutes–hours early)
🤫 quiet accum       volume arrives, price still <10%        (minutes–hours early)
↗ EMA price reclaim  price clears the 10/65 stack, volume confirms — 5 TFs (TRIAL)
👀 tick watch        +10% cross on the per-second tape       (seconds into the move)
🛰️ tick confirm      volume proves the move                  (the conviction ping)
⚡ screens           Finviz momentum / ignition / swing      (the established layer)
```

Which layer speaks first depends on the **move shape**:

| Move shape | First responder |
|---|---|
| News published before any move | 📰 radar |
| Volume builds while price sits flat | 🤫 accum |
| Slow curl over tens of minutes | ↗ EMA reclaim (and 🤫) |
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
the ↗ reclaim layer.

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

## ↗ EMA price-reclaim layer (`ema-cross.ts`; **TRIAL**, sole nomination signal since 2026-07-26)

**What/why.** The operator's TV alert pair, automated: **price Crossing Up
EMA(10) AND price Crossing Up EMA(65)** — a closed bar at/below BOTH EMAs
(the arming), then price above both (the fire). Since 2026-07-28 the arming
**survives up to `staged_arm_bars` closed bars spent INSIDE the band**
(above one EMA, not yet both): TV evaluates its two "Crossing Up" alerts
INDEPENDENTLY, and real curls stage them — FIEE cleared EMA10 at 10:35 ET
and EMA65 twenty minutes later, so a same-bar-only rule sat out a +156%
burst. Price/EMA geometry alone has no selection power (twice measured at
chance for the crossover; the reclaim inherits the same architecture), so
the reclaim strictly **nominates** and volume expansion vs sibling candles
**confirms**. Runs identically on FIVE timeframes; each is an independent
funnel with its own once-per-day confirm, observation, cooldown, and
pendings. The 10/65 **crossover** channel this file is named for was
retired 2026-07-26 (see the history note at the end).

**Timeframes.**

| TF | Warmup store (retention) | Backfill | Cooldown | Display window/cap |
|---|---|---|---|---|
| 5m | bars_5m (6d) | Databento 1m 3d → Yahoo 5m (range widens 5d→1mo→60d until ≥2× warmup bars); sparse re-seed <120 bars/24h incl. below-warmup, 2h retry, sparsest-24h first | 30 min | prunes fast / 10 |
| 15m | bars_15m (12d) | Databento 1m 10d → Yahoo 15m | 1h | 90 min / 8 |
| 1h | bars_1h (35d) | Databento 1h 30d → Yahoo 1h | 2h | 3h / 8 |
| 4h | bars_4h (130d) | Databento 1h 120d → Yahoo 1h; ET grid 04/08/12/16 | 4h | 6h / 8 |
| 1d | bars_1d (260d) | Databento 1h 240d → Yahoo 1d; 04:00-ET day grid | 1d | 24h / 6 |

A bucket closes when a trade arrives in a later bucket (TV-like) — so a 1d
bucket only closes next morning, and **intrabar detection is the 1d layer's
real-time path** (the point of having it).

**Detection.** Every live tick runs the provisional check (price above the
committed EMAs ⟺ above the fold — the algebra collapses); the closed-bar
path is the backstop. **No stale-EMA wait on this channel** (2026-07-27,
the VTAK cost: gap-decay keeps EMAs honest through silence, and a resume
print clearing the decayed stack IS the quiet-curl signal — the old guard
cost ~4 min on a 2482× burst). Floors at nomination: ≥$500 of bucket/bar
dollars (`nominate_min_notional`, calibrated on measured phantoms) and a
≥50-share sibling median — but **insufficient evidence PENDS, never
silently dies** (below).

**The confirm funnel** (unchanged from the measured crossover rules): the
reclaim bar itself at ≥5× the sibling median with ≥$10k = instant confirm;
otherwise observe 6 bars — confirm on any bar ≥3× + close ≥ reclaim ×
1.005 + ≥$10k; silent expire with peak telemetry otherwise; a confirm ends
the symbol's day on that tf, an expire re-arms after the cooldown.

**Exceptional-expansion escape** (2026-07-29, the GSUN case): the $10k floor
is price-blind — GSUN's reclaim bar ran **55.5×** its normal volume but at
$0.19/share that is $1,909, so it could not confirm while the name ran
+52%. A confirm now also passes on dollars at **ratio ≥30× AND ≥$1,500 AND
sibling median ≥2× the dead-tape floor**. All three clauses matter: the
median *nomination* bar is $1,161 so the floor earns its keep (dropping it
to $2,500 would admit ~150/day against ~86/day of confirms), and the
baseline guard exists because **a ratio is most inflated exactly where the
baseline is dust** — without it the escape confirms the dead-tape trickles
the operator deliberately left nominate-only (the PBM decision). Measured
cost: ~7/day. ⚠️ **Dashboard + grading only, no Telegram** until graded (the
X4H precedent); they are the confirms with `meta.notional < 10000`.
Dials: `exceptional_vol_x`, `exceptional_min_notional`.

**Pending shapes — evidence arrives later, the geometry is not consumed:**
1. **Thin sibling window** (AMIX): real-dollar reclaim over a <50-share
   median pends; a vertical ignition never re-dips to re-arm, so waiting
   for the "natural re-arm" loses exactly the moves that matter.
2. **Junk-dollar arming bar** (EDBL): a coherent odd-lot poke (±5% vs prev
   close) closing above both EMAs pends instead of DISARMING — 2-15-share
   prints used to consume `prevBelowBoth` while being too small to signal,
   leaving the real burst unarmed. Outlier junk prints (LBTYK class) are
   discarded.
3. **Decay-flip during a feed gap** (CPHI heritage): the flat-carry decay
   crossing fast over slow parks a pending at the carry price.
All pendings convert INTRABAR the moment bucket dollars accrue while price
holds above both EMAs (ratio + $10k decide nominate vs confirm, anchored
at the ORIGINAL arming — `cross_ts_sec`/`pending_min` in meta), and die at
any close back inside the stack.

**EMA integrity stack** (what keeps the 10/65 honest on a MINI subset
feed): gap-decay on FEED-scale bars only (empty in-session buckets fold the
last close — TV-parity horizons on sparse tapes; nights/weekends decay
nothing; **never applied when replaying a CONSOLIDATED series** — that
series is already every bar TV draws, so its holes are the market's, and
decaying them anyway dragged FIEE's EMA65 to 2.77 vs TV's 3.67 and
un-armed the channel entirely) · sparsest-24h-first 2h Yahoo consolidated
re-anchor for MINI-sparse names (<120 banked bars/24h), **including
below-warmup names**, with the fetch window widening 5d → 1mo → 60d until
the BAR COUNT clears warmup (warmup is a bar count, so a calendar window
can't satisfy it on a trickle tape: FIEE's whole consolidated week was 86
bars) ·
weekend test-session prints dropped at the live gate AND in every
historical fetcher · basis-break guard (a ≥4.85× overnight jump = split →
state reset until reseed; deliberately NOT the 1.94-4.85× near-integer band
— PFSA/LGHL doubled for real and were reset mid-burst on day one) ·
split-adjusted seeds bounded to 1-3-day seams (multi-week sparse
boundaries are organic) · corrupt-source guard (flip-flopping scales or
any bar ≥20× off the series median → discard, Yahoo fallback).

**Known blind spots (by design — the other layers cover them):**
- **Consolidated-only tape**: odd-lot/off-MINI curls (VTAK, EDBL premarket)
  are invisible until real lots print — SIP/PLUS is the only fix.
- **Already-above-the-stack ignitions** (OMH, EDBL on 5m): no crossing
  transition exists on that tf — TV's pair alert is equally silent; the
  coarser timeframes and the 👀/🛰️ tick tier are the catchers. ⚠️ Verify
  this is genuinely the shape before filing a miss here: FIEE looked like
  this class and wasn't — its EMA65 was simply null (never warmed), which
  reads identically from the outside. `ema-debug` distinguishes them in one
  call: `ema_slow: null` = a warmup hole, not a blind spot.
- **Dead-tape ⚠️ nominations** (PBM): can nominate, can never confirm
  ($10k unreachable); operator chose to keep them (no sib×price floor).

**⚠️ There is no in-flight predictor of the confirm** (measured 2026-07-29,
after a display tier was shipped implying otherwise). On 5m over 40h:
confirmed observations moved a median +0.65% from the reclaim vs +0.44% for
expired ones (65% vs 47% clearing 0.5%) — a 1.4× lift that does not widen at
a higher bar; volume ratio is circular (a confirm requires ≥3×); and the
confirm hazard is FLAT in age (~2%/bucket, **89.5% of nominations never
confirm**). This is the layer's founding result restated — the geometry
nominates, the burst is genuinely unpredictable until it arrives. Any future
"about to confirm" tier will fail the same way; the dashboard's `◆ moving`
tier is deliberately DESCRIPTIVE (live price ≥3% off the reclaim, ~6% of
rows) and claims nothing about what follows.

**Surfacing.** One sidebar section per timeframe (↗ tag, "reclaim Xm ago"
anchored at the arming bar, thin-tape ⚠️ when sibling notional <$5k,
🔥 CatalystBadge news enrichment, tf-scaled pulse on fresh confirms).
**Telegram: 5m reclaim confirms only** (`ema_reclaim` slug — mutable
independently); 15m/1h/4h/1d are dashboard+grading until promoted (one
guard line in `pushCrossAlert`). Dashboard sounds/title-flash EMA-only.

**Grading.** `tier='cross'`, `meta.signal='reclaim'` (absent = the retired
crossover's history). Cuts: `tf`, `intrabar`, `sib_median`/`notional`
(thin-tape band; pend-conversions carry inflated ratios — segment on
sib_median), `pending_min`, `in_ladder`, **`staged_bars`** (0 = a fire the
pre-07-28 same-bar arming would also have made; >0 = a staircase only the
staged arming catches — grade the two populations separately before
promoting anything to Telegram), catalyst-vs-not via join to
`news_articles`. **Clean segment starts 2026-07-29** (07-28 moved it: the
FIEE fixes changed arming semantics and warmup coverage); the
07-22→07-28 semantics boundary log lives in HANDOVER (THE PENDING TASK).
Audit tools: `GET /api/screener/ema-debug?ticker=X` (live EMAs per tf vs
the TV chart — `armed`/`armed_staged` included),
`npx tsx scripts/verify-ema-cross.ts` (38 scenarios / 128 checks), and
`scripts/research/reclaim-staged-arming-replay.ts TICKER` (replay any
name's real consolidated tape through old vs new arming).

**History — the retired crossover.** This layer began 2026-07-10 as the
EMA(6/50→10/65) crossover nominator; three weeks of live calibration
produced the guards above (LBTYK junk floor, ZBAO pendings, SKYQ stale
logic, WOK split adjustment, CPHI gap-decay). After three days running the
crossover and the reclaim side-by-side, the operator retired the crossover
(2026-07-26, `cross_detect: false` everywhere — it fired later and noisier
on the shapes that mattered; the planned A/B is moot). The machinery stays
in the code and the verify suite (CROSS_ONLY/BOTH_ON configs) so a
data-driven revisit is one flag, and pre-07-26 tier_events remain
interpretable.

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

## ⤴ MACD momentum-curl / top-gainers MOMO (`macd-curl.ts` + poller `onMacdCurlEvent`; shipped 2026-08-06)

**What/why.** The operator's LIVE trading strategy, automated (they have a
day job): they miss a leader's first move, and enter the LATER legs — pick
the session's top gainers, watch the Raschke-style **MACD 3/10/8 (all-SMA)
on 5m closes**, enter when the line turns up toward its signal after the
pullback reset ("close to the crossover", tight stop). Complements ↗: the
reclaim layer hunts a name's FIRST ignition; this hunts re-ignitions on
names that already proved themselves. Consistent with the entry-mechanics
study (pullback comes 81%, pullback-hold entry ≈2× win rate). NOT the
twice-killed standalone MACD signal — the universe conditioning (already a
top gainer today) is the entire point.

**Universe** (`MACD_MOMO`, poller): top-10 by day change (rank floor ≥10%)
∪ anything ≥30%, over the momentum∪ignition union rows; **sticky per ET
day** — once a leader, watched all session even after cooling off the
screens. AH note: late qualifiers rank on the AH-anchored row change; row
display change is FULL-DAY (tick-feed prior close), same anchor as the EMA
tab.

**Detector** (`MacdCurlTracker`): line = SMA3−SMA10 of closes, signal =
SMA8(line), warmup 17 closed bars; CLOSED 5m bars only, deliberately — the
operator's TV MACD has "Wait for timeframe closes" checked, so this is
exact chart parity. Fed from the same known-runner bar stream the EMA layer
banks (`onBarClosed`), boot-seeded from the same split-adjusted `bars_5m`
replay. Episodes run cross-down → cross-up: **SETUP** (the entry moment)
needs ≥2 consecutive rising line closes, the gap (signal−line) closed to
≤65% of the episode's max, and a dead-chop floor (max gap ≥0.3% of price);
a setup whose line later breaks below its announce level re-arms. **CROSS**
= line closes above signal. A vertical V-recovery legitimately skips SETUP
(no curl phase — straight to CROSS). Knobs: `MACD_CURL` (macd-curl.ts).

**Validated before wiring** (replay of 08-05's five leaders,
`scripts/research/macd-curl-replay.ts` + `scripts/verify-macd-curl.ts` S1–S7):
SETUP fired at the operator's own marked entries — INLF 10:35 ET → +47%/60m,
ZYBT 11:00 ET → +136%/30m, YXT 13:40 ET → +63%/60m, RITR 10:55 ET base of a
+29% run; BJDX's premarket gap-open leg was NOT catchable (the known gapper
ceiling). Raw rate ~8 setups/name/session with real failures between
(YXT 09:05 → −33%) — an attention surface, not an entry signal.

**Surfacing.** ⤴ MOMO tab (DEFAULT view since 2026-08-06, operator's call):
one row per qualified name with live state — **curling** (setup live — the
acting window, pulses when fresh) / crossed / turning / cooling / warming —
plus gap%, <0 badge (below-zero reset), setup/cross ago (bar-close
anchored), news badge, full-day chg%. NO sounds, NO Telegram (operator's
call pre-replay; the fire rate says raw pushes would spam — promote only a
gated subset after grading, e.g. first-setup-of-day or <0-only).

**Grading.** `tier='macd'`, events setup/cross (fades not recorded —
episode ends are derivable from the next cross-down). Meta: price, line,
signal, gap_pct, max_gap_pct, below_zero, rising, chg, via
(top10|chg|reseed). The cut that decides alert promotion: forward move
after SETUP by below_zero × day-change band × time-of-day, vs the same
name's non-setup bars.

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

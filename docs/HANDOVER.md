# Session Handover — updated 2026-07-03

A running handover so a fresh session can continue without re-deriving context.
**Read `docs/web-dashboard.md` first** (the canonical status doc); this file is
the "where we are right now + what's open" layer on top of it. Memory files
under `…/memory/` also carry the durable facts.

**CURRENT FOCUS (2026-07-05): 🤫 quiet-accumulation tier — measured + shipped.**
The operator's recurring EMA/MACD instinct finally decomposed into its real
carrier: volume-before-price. Conditional EMA/MACD entry test = negative (book
closed, entry EMAMACD2); the quiet+strong-fastRV cohort = real 3–7× lift
(entry QVOL) and now ships as the earliest LIVE TICKS ladder state
(accum → 👀 → 🛰️), with graded logs to tune from after a week.

**PRIOR FOCUS (2026-07-03): 📰 NEWS RADAR — catalyst-first detection, shipped.**
Operator's observation ("ticker starts moving 10–15 min after its news")
validated on our own data (median news→detection lag 7.9 min, p75 91) and
built: the market-wide Benzinga delta (+ fresh halts) matched against the
known-runner set (30d momentum/ignition history) for names not yet on any
screen → purple sidebar section + soft ping (Telegram only strong/major),
arms the tick feed, escalates to "moving ↗" when the tick detector or a
screen picks the name up, expires at 90 min with a logged outcome. See the
top "What shipped" entry (NR) for the watch items — especially the live
precision numbers to collect from logs. Prior focus (tick-feed two-tier,
2026-07-02) shipped + operator-reviewed the same day.

**PRIOR FOCUS (2026-07-02): Tick feed two-tier WATCH→CONFIRM — built, shipped.**
The operator's complaint: tick catches (and the relvol-gated screens) fire when
names are already +30–50% — on nano-caps volume confirmation is structurally
late, and prod near-miss logs proved it (three mechanisms). The detector is now
a state machine: price-led 👀 WATCH flag (baseline-free, tiny junk floor) →
🛰️ CONFIRM (unchanged surge rule / baseline-free sustain read / a screen
returning the name) → fade. Tiered alerts (👀 + soft ping on watch, 🛰️ + radar
on confirm, once/day per tier). See the top "What shipped" entry (TICKW) for
the watch items + calibration knobs. Prior focuses (EMA/MACD conditional test,
Trade Journal attribution join) remain open below.

**PRIOR FOCUS (2026-07-01): EMA/MACD confluence signal — investigated + MEASURED,
no standalone edge; the conditional test was CLOSED negative on 2026-07-05 (entry
EMAMACD2).** The operator noticed many
ignition/momentum names "jump every few days," built a TradingView indicator
(EMA 6/20 bull cross + MACD 12/26/9 confluence, testing 30m vs 1h) that *seemed*
to fire before our ignition system, and wired ~all momentum-history tickers as
1h alerts. We backtested it on free Yahoo intraday bars. **Verdict: it fires
early (high recall) but has NO predictive edge — forward hit rate ≈ base rate
(base-rate illusion + chart survivorship).** Full spec, numbers, and the one
open follow-up (conditional-on-fresh-catalyst test) in the top research entry
(EMAMACD) below. Prior focuses (Trade Journal, tick feed) remain live/valid.

**CURRENT FOCUS (2026-06-21): Trade Journal — IBKR import + P&L calendar 📅,
the first piece of the trade-journal/report system. LIVE on prod + validated.**
Deployed (3 pushes: feature + 2 follow-up fixes); the operator imported real May
+ June statements and **gross P&L matches their Tradervue to the penny** (net
within ~4¢ — per-trade rounding, not a logic gap). See the top "What shipped"
entry (TJ) for state + the next step (**the screener-attribution join — the
actual payoff**). No new env vars. Prior focus — the tick-feed detector 🛰️ —
remains live with its own open items (entry 000000).

**CURRENT FOCUS (2026-06-18): the live tick-feed early-ignition detector 🛰️** —
built, activated, validated in prod, and Option B shipped (catches → dashboard
🛰️ LIVE TICKS section, Telegram rebalanced to high-conviction only). See the
top "What shipped" entry (000000) for the full state + the OPEN items to pick
up next (outcome tracking, re-surge suppression, baseline restart-seeding,
candidate enrichment). The detailed durable record is the [[tick_feed_scoping]]
memory. ⚠️ Process note: that work briefly looked reverted in the working tree
but was committed (`3903b9e`) — **trust the commits/origin, not the tree.**

---

## Operating norms (how the operator likes work done)

- **Measure before acting.** We have `screener_outcomes` (forward 1/3/5-day
  returns per detection) — use it to validate/kill features with data, not
  intuition. Always gate `bars_forward >= horizon`; early/small samples are a
  direction check, not a verdict.
- **Ship via CI.** Commit to `main` → GitHub Actions builds + deploys (runs
  `dbmate up`). Always: build web locally (`npm run build --workspace=apps/web`)
  AND api typecheck (`cd apps/api && npx tsc --noEmit`) before pushing — the CI
  matrix is fail-fast (a web tsc error silently cancels the api build).
- **Find the real CI run id** via `gh run list` — don't guess it.
- **Push needs VPN** (operator's region blocks GitHub port 22; the agent path
  may also be blocked — if `git push` gives "No route to host", the operator
  pushes from their own terminal with VPN on).
- **Prod = DigitalOcean droplet** `root@165.245.210.95`, `/root/projects/pnldash`,
  `docker-compose.prod.yml`. Admin login admin/123456. psql via
  `docker compose -f docker-compose.prod.yml exec -T postgres psql -U pnldash -d pnldash`.
- **Operator TZ is UTC+5** (Asia/Tashkent); the app is ET-anchored.

## Current strategy thesis (operator's, evolved 2026-06-02 → 06-12)

- **Catalyst quality is the #1 factor.** Momentum + catalyst, entered on the
  FIRST appearance, ride it, **exit when the larger pullback begins** (topping
  tails, MACD roll, heavy red volume). The exit is discretionary; the dashboard
  can only *assist*.
- **Fresh first-day names are where the edge is** — confirmed by outcomes
  (below). Multi-day "continuation" is a *negative* signal.
- Two scoring axes on news: **impact_score** (catalyst quality) and
  **hype_score** (pump/crowd potential, orthogonal — the STI +700% case).

---

## What shipped this session (newest first, all on prod unless noted)

QVOL. **🤫 Quiet-accumulation tier — measured, then shipped (2026-07-05).** The operator kept seeing "EMA cross + rising MACD on flat candles" before moves (USDE: cross ~16:00–16:30 ET Jul 1, launch 17:48, NO news until next morning — so the radar couldn't see it, and the EMAMACD2 study anchored on news couldn't either). Decomposed the observation: the carrier is **volume before price**, not the indicator. Verified USDE in our own rows: momentum NEW at 16:04 ET, +6.97%, day-RVol 21×, rv5m 3,119% → every alert path silent for 104 min (all gate on chg≥10 / catalyst / score).
   - **Cohort study (55d, first appearance per ticker/ET-day, `scripts/research/quiet-accum-cohort-v2-fastrv.sql`):** quiet entries (chg<10) split by fast RVol (max rv1m/rv5m in first 5 min — session-independent; ⚠️ v1 with day-RVol was distorted, Finviz day-RV reads ~0 in PM). **Quiet + fastRV≥10× → ≥+20pt continuation 20–25% (AH, n=507) / 12–14% (PM-REG, n=315) vs 3% for quiet-no-vol** — a 3–7× lift. `seen_recently=true` slightly OUTPERFORMS within the cohort (known runner quietly re-loading). Hot (chg≥10) still has higher absolute rates but enters extended — the accum tier's value is the early cheap entry + lead time to the +10% line (USDE 104 min).
   - **Shipped:** `scanAccumulation` in poller (union rows, chg 0–10, fastRV≥1000%, within first 10 min of first sight — the measured entry semantics; once/ticker/day) → LIVE TICKS ladder entry `status='accum'` (🤫 teal). Promotes to 👀 via the detector's watch event (accum entries skip the stale/on-screen suppression) or a screen backstop at chg≥10 (display-only); confirms via normal surge/sustain; `screened_at_watch=true` blocks bogus screen-confirms. TTL 120 min with graded expiry logs. Alerts: soft dashboard ping (quietest tone) for every flag; **Telegram 🤫 only for fastRV≥3000% or accumulation+bullish-news** — once/ticker/day.
   - **v2 tuning (2026-07-07, after day-1 + a 55d feature study — `scripts/research/quiet-accum-features.sql`):** day-1 live: 43 flags, 14 promoted (36%), all 14 finished ≥+10% (BJDX flagged +8.8 → +76.6, GVH +6.0 → +41.1), fizzles peaked ≤+2.6pts. Feature study found the discriminators: **persistence** (hot ≥3 cycles in 5min: 65%/24% vs transient 35%/7%) and **sustained+bullish-news** (72%/30%, ~1.6/day); fastRV *magnitude* ranks nothing (USEA 223× fizzled, BJDX 12× won) — day-1's ≥3000 Telegram pushes were mostly fizzles while both winners were sub-gate. **Shipped:** `min_hot_cycles: 3` persistence gate (expect ~9 flags/day, −40% volume, mostly-fizzle cut) + Telegram re-gated to sustained+bullish-news only (`telegram_rv_min` retired). Sleeper to watch: entry chg 0–5% flags (ignition-side, n=17 in study) ran 82%/76% — rare and golden if it holds live.
   - **WATCH / OPEN:** (a) grade live precision from `grep accum` logs (`↗ 👀 watch` / `🛰️` vs `💤 expired (peak +Xpts)`), tune `ACCUM.fast_rv_min`/`min_hot_cycles` after ~a week; expect ~9 flags/day post-v2. (b) sub-5% ignition-side entries (chg 0–5) are included but were NOT in the measured cohort (momentum's chg≥5 gate) — check their share in the logs. (c) same in-memory restart residual as the rest of the ladder. (d) Phase 2 idea if the tier earns it: detector-side accumulation (volume surge vs quiet baseline while cum<10) for names below the momentum screen's chg≥5 gate — the only truly invisible zone left.

EMAMACD2. **RESEARCH — the conditional EMA/MACD test is now RUN; the book is CLOSED (2026-07-05).** The one salvage path left open by the 07-01 study ("does entering at the cross beat entering at our detection, on catalyst names only?") — measured. **Design:** 1,115 usable detections (momentum ∪ ignition first-per-ticker/ET-day, 55d) that had a bullish-classified article ≤24h before detection; three entries raced per event to a SHARED finish line (news+24h / news+72h peak, right-censored dropped): news-bar entry (radar-style), first EMA6/20×MACD cross after the news (15m + 30m, EMA-only and full confluence), our detection. Yahoo 15m×60d prepost bars; scripts durable this time in `apps/api/scripts/research/` (`ema-macd-conditional-*`).
   - **Verdict — no conditional edge:** paired on the same events, **cross−detection = +0.0 pts median in EVERY subset** (all / impact≥60 / strong-major / premium types, both horizons) and **cross−news = −1.5 to −2.5 pts**. The cross fires ≤24h post-news in only 70% of events, so "wait for the cross" also forfeits 30% of moves entirely — mean capture roughly HALVES vs acting on the news (+16.1% vs +32.7% @24h). Conditioning on catalyst quality does not resurrect the signal anywhere.
   - **The bonus finding that matters:** **news-entry dominates detection-entry across every cut** — @24h median +14.6% vs +6.7%, mean +32.7% vs +17.2%, ≥+20% hit 39% vs 21% (same ordering @72h and in all subsets). News→detection lag: median 351 min, p25 7 min. This is the measured case for the NEWS RADAR (entry NR below): the early edge the operator keeps sensing on charts lives in the CATALYST, not the indicator — the cross is a delayed, lossy proxy for "price moved after news".
   - ⚠️ Caveats: absolute capture levels are survivorship-inflated (every event is a name that eventually screened; radar hits that never move aren't in this sample — the radar's live precision logs remain the unconditional read). The strategy-vs-strategy comparison on shared events is the valid part. Yahoo 15m nano-cap bars are noisy but symmetric across strategies.
   - **Action:** do NOT build EMA/MACD alerts/badges in any form; the radar+tick chain already occupies the only seat where this idea's edge could have lived.

NR. **📰 NEWS RADAR — catalyst-first detection (2026-07-03).** Full spec in web-dashboard.md (top entry). The chain is now: news radar (pre-move) → tick watch (+10% cross) → tick confirm / screens. Zero new API calls — the Benzinga delta was already market-wide; we were discarding the non-screening matches. Benzinga fetch now paginates (≤3×100/cycle; bursts used to drop articles silently past the watermark — verified `page` param live).
   - **Key mechanics:** known-runner set = 30d of momentum/ignition tickers (`seedRadarHistory` boot seed + live growth); dedup by article URL/day; classify via the shared URL cache (LLM refinement upgrades in place, bearish flip drops the entry); radar entries carry a `daily_bars` prior close so `TickFeedService.syncScreenRows` (30s) arms the detector for non-universe names; escalation check runs in the payload build (`screenRowByTicker` / `tickCatches`); session='closed' skipped.
   - **WATCH / OPEN:** (a) **precision unknown until live** — the DB couldn't measure how many headlines lead nowhere; after ~1 week: `docker compose logs api | grep news-radar` → hit rate = `↗ moving` / (`↗ moving` + `💤 expired (no move)`), per catalyst type/impact band; then tune display gates (currently ALL non-bearish shown) + the Telegram gate (strong/major). (b) expect **premarket 8:00–9:30 ET burst** — if the section floods, add a `min_impact` display gate (`NEWS_RADAR` const). (c) radar entries are in-memory (deploy loses them; `radarSeenUrls` dedup also resets → a deploy can re-radar an active article — same known residual as tick catches). (d) marketContext is null at classify time (no live float/mcap for non-screening names) → hype skews low until the LLM pass lands.

ACCUM2. **Detector-side 🤫 — the sub-screen accumulation tier (2026-07-08, the SLS case).** Operator raised EMA/MACD a fourth time with a real win: their 1h TV cross alerted SLS at 09:25 ET (+3%), our first signal was the 👀 at 09:41 (+10.2%). Diagnosis: SLS **never hit any screen** (day-RVol never cleared momentum's 5× Finviz gate; $14 ≫ ignition's sub-$1), so the screen-scanning accum tier was blind and the tick feed's first word is the +10% watch — a structural sub-10% blind zone for unscreened names. **Built the queued phase 2:** the tick DETECTOR now emits an `accum` event when cum ∈ [3%, 10%) AND trailing volume ≥3× its own quiet baseline, SUSTAINED 120s (the measured persistence lesson), with the junk floor + near-high checks (`TICK_DETECT.accum_*`). Rides the existing ladder (teal 🤫 row, promotes at the +10% cross, confirm/TTL/tier_events with `meta.source='tick'` vs `'screen'`); dashboard-only — no Telegram until tier_events grades this source. Also fixed a latent baseline bug found on the way: surge windows below mom_min used to feed the "quiet" baseline and self-dampen (an accumulation burst at +4% polluted its own reference); quiet sampling now excludes ≥3× windows. Regression: identical watch/confirm timings, false-confirms 1/38 unchanged, 0 accums on the fizzler control, gappers correctly produce no accum (hold unmeetable at their speed). **Watch:** detector-accum volume/day unknown — grade `tier_events WHERE tier='accum' AND meta->>'source'='tick'` after a few days; dial `accum_relvol_min` 3→5 if noisy.

TIEREV. **tier_events table — grading now survives deploys (2026-07-07).** Found while answering "are all components working?": every CI deploy recreates the api container and WIPES docker logs — four deploys that day erased the tier-grading evidence four times (the SOC radar hit was only reconstructible from the DB). New `tier_events` table (migration `20260707200000`): every 🤫/👀/🛰️/📰 transition the poller used to only console.log is now also inserted fire-and-forget (`services/tier-events.ts`, error-throttled, never blocks a cycle). Events: accum flag/promote/expire · tick watch/watch_suppressed/confirm/fade/watch_expired · radar hit/moving/expired/dropped, each with a meta jsonb (chg, rel_vol, mom, via, pts, minutes, impact, reason…). **Grading is now SQL over any date range** — e.g. accum precision: `SELECT count(*) FILTER (WHERE event='promote') … FROM tier_events WHERE tier='accum'`; evidence-gate audit: suppressed-low-evidence tickers that later confirm. Also finally closes the "tick catches are display-only / no persistence" open item. Console logs kept (live tailing).

TICKW-EV. **Watch-tier evidence gate (2026-07-07, the drift-crosser fix).** Operator: "is it OK every watch-ticker already extended?" — LIVE TICKS showed VSTM/ADCT/FBRX/BZFD, all +10-14% via hours-long grinds (ADCT multi-day), all crossing at ≤2× rv and ~0%/60s mom. Same class as day-1's RIOT/CLSK/JOBY sector-drift spam (~80 👀 pushes that day). **Fix:** a watch must show evidence AT the cross — `rel_vol ≥ 3×` its own quiet baseline OR `mom ≥ 3%/60s` (`TICK_WATCH_EVIDENCE`, poller). Gated in the POLLER, not the detector: the anchor still plants, so surge/sustain confirms remain fully live for suppressed names (BFLY/FBGL-style late bloomers still 🛰️). Every day-1 watch that mattered passed the gate; suppressions are logged (`low evidence at cross`) so the gate's cost is auditable — check for `suppressed — low evidence` names that later confirm.

TICKW-AH. **After-hours tick-feed blind spot closed (2026-07-03, the UPC case).** Operator: "Momentum showed UPC 38 min before the live-feed — is that OK?" Reconstructed: UPC hit Momentum 16:03 ET; the news-radar deploy landed 16:33 (mid-AH) and reset subscriptions; detector's FIRST UPC bar was 16:33 at +55% → stale watch (suppressed, correctly) → sustain-confirm 16:37. Most of the gap was the deploy reset (known residual), BUT it exposed a standing hole: `syncScreenRows` skipped AH rows entirely (their change/price are today-close anchored), so an AH runner outside the frozen-after-4pm universe was invisible to the detector for its whole run. **Fix:** AH screen rows now subscribe with a `daily_bars` close as the anchor (same as radar arming; `pendingPrior` dedupes lookups). Also stopped mixing anchors in LIVE TICKS rows/alerts during AH (UPC showed "⚑ +56%" beside "+29.11%" — prior-day vs today-close): AH refresh updates price only.

TICKW. **Tick feed two-tier: 👀 WATCH → 🛰️ CONFIRMED (2026-07-02).** Operator: "when I get the tick catch they're already 30–50% up — RelVol on nano-caps arrives too late; flag by change% first, confirm/remove when volume shows." Prod near-miss logs (last 7d) confirmed three lateness mechanisms: **no-baseline gappers can NEVER fire** (LHAI +238%, EHGO +120%, USDE +168% — quiet sampling stops at cum≥8%, so 0-quiet names are invisible all session), **relvol≥5× clears 20–30 pts after price** (DSY +23% @1.8× → fired +56.7%; SDEV +19% → +47.6%), **slow grinders never trip mom≥8%/60s**. Catches fired at +23–63% (median ~+40).
   - **Built:** `tick-detect.ts` is now a per-symbol state machine (idle→watching→confirmed|faded; full detail in web-dashboard.md). WATCH = cum ≥10% (≤100) + near-high + junk floor (≥5 prints & ≥$2k notional/2min — kills the "+15% on 5 shares" prints). CONFIRM = old surge rule (unchanged — strict superset) | baseline-free sustain (≥2min + ext ≥3pts + ≥flag price + ≥$25k since flag) | screen pickup (poller payload build promotes watch entries that appear in momentum/ignition). FADE = 15min or 60% giveback; surge rule can resurrect a faded name. Watches suppressed for already-screened names (redundant + would self-confirm). Also `syncScreenRows()` in tickfeed.ts (30s) — subscribes current screen rows instantly w/ row-derived prior closes (not in AH — anchor shifts), closing the 10-min universe-lag "0 quiet" hole.
   - **Alerts tiered (operator asked for a watch alert too):** 👀 Telegram + soft dashboard ping on watch; 🛰️ Telegram + radar ping on confirm; each once/ticker/ET-day. UI: LIVE TICKS rows amber (watch, "👀 pending") / blue (confirmed, `⚑ +N%` shows the flag point) / grey faded (3-min linger). `/health.tickfeed` now reports watches/candidates/fades/extra_subs.
   - **Fix (same day, the AUID miss):** v1 suppressed ANY watch on an already-screened name — but a non-catalyst momentum row generates no push, so suppressing the watch left the sustain-confirm at +18.3% as the operator's FIRST AUID signal (momentum had it at +9.5%, watch fired +13.9% → eaten). Now the detector tags each watch `fresh_cross` (did we observe the symbol trade below the 10% line before crossing, vs first-sight-already-above) and suppression only applies to STALE crosses on screened names (the deploy-boot / mid-move-subscribe flood case). Fresh crosses alert even when screened; for those, `screened_at_watch` blocks the screen-pickup promotion (pre-existing screen presence ≠ fresh volume evidence — they confirm via surge/sustain only). Boot race closed too: before the first poll cycle lands, screen state is unknown (`lastPayload` null) → stale watches suppress (first deploy re-pinged CWD +87%). Known residual: the alert-dedup sets are memory-only, so a mid-session deploy can re-ping a name already alerted earlier that day (ties into open items c/d — restart-seeding / persistence).
   - **Fix 2 (same day, CETX/CLRO operator review):** (1) LIVE TICKS rows now refresh price/chg from the screens each cycle — a watch row frozen at flag values ($3.88/+38.6%) read as broken beside the Ignition row at +106% (CETX); the ⚑ marker carries the flag point. (2) ⚑ shows whenever `watch_change_pct` is known and differs from current chg — CLRO's Telegram said "flagged at +14%" but the UI hid it (direct-confirm entries had `caught_at === confirmed_at`). (3) **Express sustain lane** — `confirm_fast_hold_sec` 30 + `confirm_fast_ext_pts` 20: a move that extends ≥20pts beyond the flag on ≥$25k doesn't sit out the full 120s hold (CETX was "pending" at +106%). Regression: CIIT confirms ~2min earlier, control false-confirms unchanged (1/38). Note the CLRO pattern: a T3 halt-resume has no below-line tape, so its watch classifies stale → suppressed; the ⚡ ignition alert (+10.6%, catalyst path) is the early signal there — by design.
   - **Regression (data/dbpull, `npx tsx scripts/verify-tick-detect.ts`):** previously-uncatchable gappers INHD/SUNE/CIIT/PPCB now confirm via sustain; watch flags 17–114s pre-Finviz at lower chg; false-confirms on the 38-fizzler control 1/38 (3%, was ~5%); 3/4 fizzler watches faded on their own. Synthetic edge tests (junk floor, giveback fade, faded→surge resurrect, cum_max cap) all pass.
   - **WATCH / OPEN:** (a) **live alert volume** — expect ~10–20 👀/day; if spammy raise `watch_cum_min` 10→12 or the junk floor, or drop the 👀 Telegram (keep dashboard) — `TICK_DETECT` consts + `formatTickWatchAlert` call site. (b) **$ knobs are EQUS.MINI feed-visible dollars** (fraction of consolidated tape) — first guesses; recalibrate `watch_floor_notional`/`confirm_notional_min` from a few days of `[tickfeed]` watch/confirm/fade logs. (c) watch→confirm→fade **transition telemetry is log-only** — the outcome-tracking open item (000000.a) now matters more: grade watches AND confirms vs forward returns. (d) tick catches still display-only (no float/catalyst enrichment, no DB persistence).

EMAMACD. **RESEARCH (not shipped) — EMA/MACD confluence has no standalone edge (2026-07-01).** Operator's manual TV strategy, investigated because many of our names "jump every few days" and his indicator seemed to lead our ignition. **Exact signal (locked from the TV MACD source):** on 30m or 1h — `crossover(EMA6, EMA20)` AND `hist>=0 AND hist>hist[1]` (the dark-green `#26a69a` histogram = above signal + expanding) AND `macd>macd[1]` (MACD line rising). Zero-line NOT required.
   - **Method (free, reproducible — scripts were in the session scratchpad, now gone; re-derive from this):** Yahoo chart API `query1.finance.yahoo.com/v8/finance/chart/{TICKER}?interval=30m|1h&range=60d&includePrePost=true` (works locally, no auth). Universe = our ignition-history tickers (`ignition_results`, last 40d, one row/(ticker,ET-day) with `min(polled_at)` = our first detection, `max(change_pct)` = peak). **v1 lead-time** on 120 known movers (peak≥20%): does the signal fire in the 48h before our detection, and how early. **v2 precision** on all 472: from every fire, forward peak over 24h/72h vs a random-bar baseline (every 15th bar), right-censoring dropped.
   - **v1 (lead):** 30m confluence fired before **68%** of ignitions, **median ~15h early** (30m EMA-only 73%/14h; 1h ~52–57%/~16h). Looks great in isolation — but that's the trap.
   - **v2 (precision) — the verdict:** P(≥50% peak in 72h | fire) = **7.4–7.7%** (all TF/variants) vs **random-bar baseline 8.1–8.4%**. i.e. **~0.9× baseline — at or slightly BELOW chance.** Same at ≥20/≥30%, 24h/72h. The signal fires ~0.5–0.6×/ticker/day, so there's almost always a recent cross before any move (that's the "leads 68%"), but it does NOT concentrate moves better than random. The clean LGO/DXF/BTCT charts are **survivorship bias**. Slightly-below-baseline fits the operator's own "chasing/continuation is weak" thesis — an EMA cross means the first leg already happened.
   - **On the two sub-questions:** MACD confluence vs EMA-only cuts alert *volume* ~20% (0.49 vs 0.61 fires/tk/day) with **identical** hit rate — filters quantity, not quality. 30m fires ~2× as often as 1h (0.61 vs 0.27) for the **same** edge.
   - **Conclusion:** do NOT ship as a standalone signal/alert (firehose at base-rate accuracy — the "too many alerts" the operator already felt). "Measure first" saved building noise.
   - ~~**OPEN (the one salvage path):** conditional test~~ → **RUN 2026-07-05, negative — see entry EMAMACD2 above. Book closed.**

FLT. **Float filter bug — momentum silently capped at 100M (found + FIXED 2026-06-23).** Operator: "ILLR didn't appear; I raised Max float to 200M but still nothing." There are TWO float controls: the Finviz `sh_float_u<bucket>` token in the filter *string* and the code-side `float_max_m` post-filter (finviz.ts). `FiltersDialog.floatBucket()` mapped Max-float to Finviz's "under" presets which **cap at 100M** (`[1,5,10,20,50,100]`) and on no-match fell back to 100 — so Max-float=200 emitted `sh_float_u100`, and Finviz dropped ILLR (float **177.5M**) before `float_max_m=200` ever applied. Also violated CLAUDE.md ("never put Float in the Finviz filter string" — it drops null-float nano-caps; the code DEFAULTS correctly omit it). **Fix:** (1) live config PATCHed to drop `sh_float_u100` → ILLR shows now (verified #1 in a Finviz probe; it was +296% today, passed price/relvol/change — only the 100M cap excluded it). (2) `buildFilter()` no longer emits any `sh_float` token — float ceiling is solely `float_max_m` (expresses any value); removed the unused `floatBucket`/`FLOAT_FINVIZ_BUCKETS`; added a "enforced server-side — any value works" hint on the Max-float field. **Note:** the dialog rebuilds the whole filter string on submit, so a future Max-float edit will no longer re-introduce the cap.

AHMOM. **After-hours Momentum fix — same volume gate (2026-06-23).** Operator: "AH momentum has too many tickers without volume — BLIV, GRAN." Same root cause as the AH ignition fix below: `toAfterHoursFilter()` drops the momentum filter's `sh_relvol_o5` gate (Finviz freezes relvol at the close). The `ta_change_5to`→`ah_change_5to` change gate *does* work (every row had AH change ≥5%), but with no volume gate, names that ticked >5% on a *handful of AH shares* flooded in (live: **BLIV +6.8% on 5 shares, GRAN +8.4% on 90 shares, FEBO +5.3% on 2 shares** — rv5m≈0; vs real movers NEXR 6.9M/rv5m 6049, RCT 4.5M, DLHC 268K). **Fix:** AH-only filter on the momentum payload `rows` (poller `~1432`) — keep a row only if `max(rel_vol_5min, rel_vol_1min) ≥ AH_MOMENTUM.rvol_min` (default **100** = 1×) OR it's freshly-appeared (cold-start via `first_seen_at`, within `AH_MOMENTUM.cold_start_ms`=2min). Filters only the displayed list, not `enriched` (so catalyst banners/alerts are untouched). Tune via the `AH_MOMENTUM` const. Mirrors the ignition gate.

AHIG. **After-hours Ignition fix — re-impose the volume gate (2026-06-23).** Operator: "is the ignition list working in AH?" Diagnosed **degraded**: `toAfterHoursFilter()` (finviz.ts) drops `sh_relvol_o2` in AH (Finviz freezes relative volume at the 4pm close) and `sh_curvol_o500` then filters on *frozen regular-session* volume — so the volume-led screen pulled in flat, low-volume names (live evidence: LNKS +4%/0.2×, SCNI 0%/0.2×, BIAF +0.6%/0.27×; ~31% of 3-day AH ignition rows had relvol<2). Display was fine (the v=152 AH change/price overlay works) — only *selection* was wrong. **Fix:** AH-only code post-filter on *established* ignition rows requiring our own AH-aware RVol — `max(rel_vol_5min, rel_vol_1min) ≥ IGNITION.ah_rvol_min` (default **100** = 1×); `is_new` rows are exempt (cold-start, RVol not measurable in the first ~75s, inside the 2-min new window). rv5m/1min come from the AH volume deltas, so they read ~0 for junk and 100s–10000s for real movers (VTAK 5264, HSCS 69929) — a clean split. `poller.ts` ~line 1300. **Tune:** `IGNITION.ah_rvol_min` (raise to prune harder). Regular/PM sessions unaffected. **Watch:** confirm the dead names drop from the AH sidebar; the runner-score already ranks the survivors.

TJ. **Trade Journal — IBKR import + Tradervue-style P&L calendar 📅 (2026-06-21, LIVE ON PROD + VALIDATED).** New top-level `/journal` page (header Dashboard|Journal switch). Drag-drop an IBKR TradeLog `.tlg` → server parses + dedupes + stores; a month P&L calendar (net/gross toggle, green/red day cells with trade counts, weekly + monthly totals, month summary strip); click a day → round-trip drill-down. The calendar auto-lands on the most recent month with trades (and jumps to the imported month after an import) so importing an older statement isn't an empty grid.
   - **Model:** `broker_imports` (file meta + sha256) + `trade_executions` (one row/fill, `UNIQUE(user_id, exec_id)` → idempotent re-import; free-form text cols are `text` — IBKR open/close can be a sub-code like `C;IA`, venue can be a list). Round-trip *trades* are **derived in code** (`services/ibkr-tlg.ts` `matchTrades`), not stored — flat-to-flat per symbol, P&L `−Σamount` (`+Σcommission` net), attributed to the **exit date** (overnight holds land on close day). Routes under `/api/trades` (import/calendar/day/range/imports + DELETE). `express.json` limit 100kb→5mb.
   - **Validated on prod:** the operator imported real **May + June** statements — **gross P&L matches their Tradervue to the penny** (May −$98.03, June $327.88); net within ~4¢ (per-trade cents rounding vs TV's sum-then-round — not a logic gap; commission totals agree to ~1¢). Day cells use compact whole-dollar formatting; the header keeps full cents. An integration test vs Postgres confirms import → dedup → calendar → drill-down.
   - **Shipped as 3 pushes:** feature (`ebaabcd`) + fix: widen text cols for `C;IA` open/close (`37235b6`) + fix: calendar lands on the month with data (`9a9a33e`).
   - **NEXT / OPEN:** (a) **the payoff (next big step)** — join trades to `screener_outcomes` + detections on `(ticker, et_date)` for per-trade screener attribution (the "analyze the whole process" report). (b) Only IBKR `.tlg` STK_TRD parsed (options/futures records ignored). (c) One overnight trade's *count* differs from Tradervue by 1 (they also tally it on the open day); P&L unaffected. (d) Optional: make net penny-exact (sum raw, round once) — currently ~4¢/mo off TV.
   - Aside: **charts investigation** (can the TV embed show 1s/10s off the Databento feed?) — **no** (closed iframe fetches its own 15-min-delayed data; free embed floors at 1-min). Path = Lightweight Charts aggregating our 1s feed, but needs bar capture+SSE+persistence. Written up in web-dashboard.md "TradingView free embed widget". Deferred.

000000. **Live tick-feed early-ignition detector 🛰️ — BUILT, ACTIVATED, VALIDATED, + Option B shipped (2026-06-17→18).** Databento EQUS.MINI per-second feed catches an ignition START 30–90s before Finviz. Subscribed Standard/US-Equities ($199/mo flat, live EQUS.MINI included, $0 metered), `TICKFEED_ENABLED=true` on the droplet, stream/CRAM-auth works, healthy at scale (2.6k symbols, ~300k bars/day, no errors). **First prod win: MNTS caught 20 min before the momentum screen.** Additive edge — big wins on relvol-gated slow-burns, ties/trails on fast-starters Finviz's change gate catches.
   - **Option B (`3903b9e`, live): tick catches go to the DASHBOARD, not Telegram.** A pinned **🛰️ LIVE TICKS** section atop the Ignition sidebar (`payload.tick_catches`, blue palette, `TickItem`); `onTickCandidate` records to a `tickCatches` Map (no push), pruned when a screen catches the name up or after a 15-min TTL. **Telegram rebalanced**: 🚀 fresh-burst + 🆕 new-ignition pushes SILENCED (dormant, easy re-enable — those names already show in the sidebar); Telegram now high-conviction only (≥65 ignition, momentum strong/major catalyst, dual-signal, swing).
   - ⚠️ **Git incident (2026-06-18):** a working-tree revert of Option B briefly made the code *look* alert-only — but `3903b9e` was committed/pushed/deployed. **Check origin/commits, not just the working tree.** Tree restored + clean.
   - ⚠️→✅ **DEPLOY-KILLS-THE-FEED bug (found + FIXED 2026-06-22).** The feed silently died after the 06-21 deploys — `/health.tickfeed` showed `running:true` but `bars_seen:0, symbols_tracked:0, last_error:null` for ~21h. Root cause: Databento `BentoError: User has reached their open connection limit`. On a CI deploy the new container's sidecar tried to connect while the old one still held the Databento Live slot → limit hit → the sidecar's retry loop created a fresh `db.Live()` each attempt **without closing the old one** → leaked connections pinned the limit forever. Leak lives in-process, so `docker compose restart api` recovers it (used as the immediate recovery; verified bars flowed). **Fix shipped:** sidecar now closes the client in a `finally`, handles SIGTERM/SIGINT to cleanly release the session on container stop (frees the slot for the next container → no deploy overlap), backs off 30s on the connection-limit error so an overlapping session drains, and surfaces errors to `/health.tickfeed.last_error`; `tickfeed.ts` chunks the `SUB` into 400-symbol lines (fixes the "unknown command: …" fragmentation), re-`sync()`s ~3s after each spawn (respawned sidecars no longer wait up to 10 min for a SUB), and clears `last_error` when bars resume. **Operational check after any deploy:** confirm `/health.tickfeed.bars_seen` climbs within ~1–2 min; the fix should self-heal the overlap, but `docker compose restart api` remains the manual recovery if it ever wedges.
   - ⚠️→✅ **CATCHES INVISIBLE IN THE UI (found + FIXED 2026-06-23).** Operator: "I didn't see it working." The detector was firing fine (11+ catches/day — WETO/MGRX/VTAK/ENTX…) but the 🛰️ LIVE TICKS section was ~always empty. Root cause: the payload-build pruned a catch the instant `screened.has(ticker)` was true, and the **volume-led Ignition screen (no change gate) absorbs the same surge within a cycle or two** → each catch flashed for only seconds (confirmed: VTAK caught 20:20:59Z, in the Ignition list ~16 min later). **Fix:** dropped the screened-prune; catches now persist a rolling 15-min TTL window regardless of screen state (a name showing in BOTH LIVE TICKS and Ignition is the point — proves the tick feed flagged it first). `poller.ts` ~line 1387. No type/UI change. **Net: the tick feed's real lead is over the change-gated *Momentum* screen, not the volume-led Ignition screen — so LIVE TICKS is best read as "recent early catches," not a strict pre-screen queue.**
   - 🔔 **NOTIFICATIONS ADDED (2026-06-23) — partially reverses Option B.** Operator missed RDGT while away 10 min: tick catches had NO notification (dashboard-only, glance-only). Now every new catch fires **both** a Telegram push (🛰️, reaches the phone when away — `formatTickCatchAlert` in `poller.ts`, once/ticker/ET-day via `alertedTickCatch`, gated on `telegramEnabled && !alertsMuted`) **and** a dashboard sound + browser notification (`radarPing` + `notify` in `useScreenerAlerts.ts`, deduped via a `seenTicks` ref so a 15-min-persisting catch pings once). Operator chose "every catch" (~11/day) — no strength filter. If it gets noisy, add a rel-vol/momentum threshold in `onTickCandidate` (Telegram) and/or filter `newTicks` (dashboard); `/alerts off` mutes the Telegram side. The slower ≥65/dual/swing paths can still fire later for the same name (independent dedup) — intentional (more context), watch for double-pings.
   - **STILL OPEN (next session):** (a) no forward-outcome tracking for tick catches — instrument into `screener_outcomes`-style grading to prove the edge over time; (b) HAO-style re-surge suppression — watch whether catches on already-long-visible names feel noisy; (c) deploys reset detector baselines (even web-only) — add restart-seeding like ignition/VWAP; (d) tick catches are display-only (no float/catalyst/shelf enrichment, no DB persistence). Detail in [[tick_feed_scoping]] memory + the original build entry below.

000000b. **Tick feed — original build entry (behind a flag, pre-activation).** Databento EQUS.MINI per-second feed → catch ignition START 30–90s before Finviz. Offline-validated ($0 free credit): rel-volume (not $) separates real ignitions (9.8–100× baseline) from blips (0.3–0.7×); DSY/GLXG/BYAH caught 15–90s early at far lower chg; gappers (INHD/RGNT) uncatchable; 3–5% false-fire on fizzlers. Pieces: `tick-detect.ts` (pure causal detector, verified by `scripts/verify-tick-detect.ts`), `sidecar/tickfeed.py` (official `databento` Live client — no Node client exists; fields verified vs 0.80), `tickfeed.ts` (spawns sidecar, feeds detector), `poller.onTickCandidate` (🛰️ alert, mutually exclusive w/ other alert paths), universe prior-close extension, Dockerfile (runtime → Debian slim + python3 + databento; **image built+verified locally, 767MB**). **ALL behind `TICKFEED_ENABLED` (default off).** ✅ **Go-live DONE** (subscription + flag + smoke-test all complete — see entry 000000 above). Ceiling: recovers Finviz's lag on *ramping* runners, can't catch *gappers* (the biggest movers). Full detail in web-dashboard.md + [[tick_feed_scoping]] memory.

00000. **Ignition restart-seeding + 🆕 new-ignition alert + 2 removals (2026-06-16).**
   (1) `seedIgnitionState()` on boot rebuilds `ignitionFirstSeen` + alert-dedup
   sets from today's `ignition_results` — fixes deploys flashing the whole list
   as "new" and re-blasting alerts (same restart-safe pattern as
   firstSeen/VWAP). (2) New 🆕 alert for a recently-appeared ignition (≤15 min
   old) building into the 40–64 band (chg 10–100, non-bearish, dedup/day,
   skips already-🚀/≥65) — fills the gap between fresh-burst (≤5M) and the ≥65
   alert that fires hours late. ~6–8/day; dial `NEW_IGNITION.alert_score`.
   (3) Removed Universe News tab + `/feed?universe=true`, and the Quote-Details
   Ignition sub-tab + `/ignition-history` endpoint.

0000. **Ignition float cap 15→25M (2026-06-15).** CAST (16.5M → +364%) was
   excluded from ignition entirely. 10-day study: 15–25M band runs as hard as
   2–5M, harder than 10–15M (34% vs 14% reach +40%); 25–50M falls off → 25M
   ceiling. Paired change: `IGNITION.float_max_m 15→25` + runner-score ladder
   `<25M→6` (cap + score must move together or raised names never reach the 65
   line). ~4.7 new ignition-eligible names/day. fresh-burst stays ≤5M
   (nano-float validation doesn't transfer). **Watch:** grade the 15–25M band
   vs `screener_outcomes` once mature; the 82-row study was a momentum proxy.

000. **Swing score v2 — "early volatile breakout" (2026-06-13).** Operator
   review confirmed by outcomes: old score was INVERTED (alert set ≥65 had the
   LOWEST upside, peak_5d +2.8 vs +8.4 for sub-50; mature-trend/at-high/
   tight-base rewards all backwards; ATR unscored). v2: Volatility(25, ATR%) +
   Room(15, below-52w-high) + Trigger(30, day-1/2 FRESH 15-bar-high cross +
   15-bar base + close) + Volume(15) + Trend(10 nudge, reversals allowed) +
   Catalyst(10) + Extension(−15..0) + Shelf. Alert ≥60 + fresh cross.
   Reconstruction-validated: ≥60 → peak5 +12.1, 17%≥+20, 7%≥+40, ~3.5/day.
   ⚠️ breakdown keys + flag semantics changed 2026-06-13 (broke_out = day-1
   fresh cross); old/new swing scores not comparable across the date. chg_5d
   negative everywhere — score targets peak capture, not passive holds.
   **Watch:** let new-score outcomes mature ≥5d before judging; expect ~2-4
   alerts/day.

00. **Fresh-burst alert 🚀 (2026-06-12, after the RVol study).** Catches the
   "new ticker rallying from the very beginning" case (DSY: +10→+47% before the
   screens even returned it; ignition alert structurally too slow — vol
   component needs the 5-min read, PM penalty −8 kept DSY at 64<65). New
   `pushFreshBurstAlerts` over the enriched union, first 3 min after first
   sight: float ≤5M, chg 10–80, `max(rv1m,rv5m) ≥ 8000` (or day-RVol ≥30 in
   REG — day-RVol is *useless in PM*, measured), PM+REG only, once/ticker/day.
   Plus 1-min RVol cold start (~20s, second cycle). Sim: ~12.7/day, med +13pts
   in 30min after alert, 47% ≥+15pts; catches DSY/CUPR/ASBP (+77/+76/+39).
   Knobs in `FRESH_BURST` (`poller.ts`). **Watch live alert volume the first
   PM/REG sessions — if spammy, raise `rvol_fast_min` 8000→10000 (15000 loses
   DSY).**

0. **RVol study + fixes (2026-06-12, committed after the ignition recalibration).**
   Reviewed Momentum's Heat + 5-min-RVol pipeline against an 8-day offline
   replay of prod per-cycle series (965k rows, simulation validated 0.995 vs
   stored). Found + fixed: **(a)** the "5-min" RVol anchor drifted to the 600s
   history cap for any name tracked >5 min — a ~10-min window, median **2.04×
   inflated** (⚠️ **scale break: rows before 2026-06-12 carry the old scale**;
   ignition volume tiers halved to 1500/500/250/100 to compensate); **(b)** new
   **`rel_vol_1min`** end-to-end (column, persisted both tables, alerts meta) —
   at matched alert rates it flags 43% of imminent surges vs 28% for the old
   metric, equal precision, and 1m+5m both-hot is the strongest live tell
   (59.5% vs 30.7% base); **(c)** Heat's RVol ladder was saturated (80% of rows
   cleared tier 1) — re-anchored to measured percentiles + a +6 both-windows
   burst bonus. Details in web-dashboard.md "Recent additions". **Watch:** Heat
   distribution shifts (RVol tiers now actually differentiate) and ignition
   scores for *established* names sit slightly lower on the corrected metric —
   don't re-judge the recalibration off the first day or two; the 1m/5m
   "drying-up" ratio (t1/t5 < 0.5 → cooling) is a measured candidate for a
   future exit-assist.

1. **Finviz rate-limit fix (the big one, 2026-06-11).** Swing tab was empty.
   Root cause: **Finviz Elite ceiling is ~1 req/s** (measured: a 2nd call 300ms
   after the 1st 429s), and we blew past it — daily-bars drained 60 calls/min +
   the poller's concurrent per-cycle burst. Swing (last screen each cycle) lost
   the race → 429 → empty. Fixes: daily-bars drain `1s→4s` (`daily-bars.ts`);
   **global `rateLimitGate()` in `finviz.ts` spacing ALL Finviz HTTP ≥1.1s
   apart**; typed `FinvizRateLimitError` (429 no longer silently "no rows");
   bounded swing empty-retry (2 min) in `poller.ts`. Verified: 429s ~30/min→0,
   swing repopulated. See `docs/web-dashboard.md` incident report.
   - Debug-log cleanup done 2026-06-13: the per-refresh `swing fetch —` log is
     removed; the `swing scan empty —` warn was **kept deliberately** — it
     fires only on the failure case (and now carries the fetch error).
2. **Continuation demoted → "Faders" (2026-06-11).** Outcome data: the
   continuation pattern is a NEGATIVE long signal (−2.4%/28% win over 5d vs
   +3.2%/39% for fresh names). Moved tab to last, relabeled "Faders", banner
   "already ran — fade/short, not a long entry". Logic unchanged.
3. **Momentum Heat sort + ↑VWAP-reclaim badge + Appeared column (2026-06-10).**
   Default-sorts by composite `heat` (freshness+accel+VWAP-reclaim+5m-RVol+
   news) so fresh/rising names beat stale big-Chg% leaders. `first_seen_at`
   DB-seeded on boot. New `EnrichedRow` fields: `heat`, `vwap_reclaim`,
   `first_seen_at`.
4. **hype_score (2026-06-05)**, **burned-ticker ⛔ warnings (2026-06-04)**,
   **Outcomes/backtest tab (2026-06-02)**, **forward outcome tracking
   (2026-06-02)**, watchlist v2, multi-day news — see web-dashboard.md.

---

## RESOLVED — Ignition recalibration (2026-06-12, code-complete, awaiting commit/deploy)

The operator chose **(d) dig deeper → then recalibrate runner_score**. Done.

**Where the edge concentrates** (22-day `screener_outcomes`, ignition):
- **The golden cohort**: fresh, *regular-hours* ignition up **25–100% intraday,
  no pre-market run** → **+14.9%/1d and HOLDS +14%/5d** (the only ignition slice
  that doesn't give back). The old score put it at avg ~45 (below the 58 line) —
  only 29% alerted, and the *non-alerting* ones outperformed the alerting ones.
  The score was inverted against its own best cohort.
- **PM-exhaustion**: the *same* 25–100% move that traded in PM did 0.0%/1d.
- **Catalyst TYPE, not impact**: FDA/clinical +14.6%/1d (holds 5d); dilution
  −8.3, partnership −5.0, M&A −3.4 — yet M&A/partnership were scored *bullish*
  and got positive points. High impact_score / urgency trended negative.
- **Day rel_volume** (25×+ → +4.4%/1d) predicts cleanly; the 35-pt Volume
  component keyed off `rel_vol_5min`, which is null/0 ~40% of the time.
- **Shelf penalty was inverted**: effective/active shelf names out-performed at
  1d (it's a multi-day kill-switch, not a same-session signal).

**Shipped (code-complete; typecheck + web build pass; NOT yet committed — operator
pushes via VPN):** rewrote `runner-score.ts` — Float(30) + Volume(30, max of
5-min & day-RVol ladders) + type-aware Catalyst(−15..+15) + Maturity(−25..+12,
rewards the 25–100% band) + Pre-market(−8..0) + Shelf(−5..0, active only).
Breakdown keys `earliness`/`halt` → `maturity`/`premarket`. Poller: new
`seenInPremarketToday` set (midnight-cleared), `scoreRunner` call passes
`catalyst_type` + `seen_in_premarket`, `alert_score` 58→**65**,
`alert_entry_chg_max` 40→**100**, alert bypass retied to premium catalyst
(`b.catalyst ≥ 8` = FDA/news-halt) instead of any bullish-strong/major. Web:
`RunnerScoreBreakdown` + two tooltips updated. Spec §3 rewritten.

**Validation (reconstructed new score on history):** alert set `≥65 ∨ premium
catalyst, cap 100` → **+13.9%/1d, +5.2%/5d, ~5/day** vs old `≥58, cap 40` →
+4.7%/1d, −0.4%/5d, ~8/day. Monotonic (58→+8.9, 65→+17.5, 70→+24.6). Win rate
stays ~45% — it's an **asymmetric positive-skew lottery** (median ~flat); the
recalibration concentrates the right-tail runners into the alert set and kills
the 5-day give-back. Matches the operator's "ride winners, cut losers" thesis.

**Watch after deploy:** new `screener_outcomes` rows for `screen='ignition'`
will accrue under the new score — let ≥5d mature before judging live, don't
retune off the first few days. The reconstruction used `first_change_pct` for
maturity (live uses current `change_pct` via the day's max-score cycle) — a
small in-sample/live gap to keep in mind. Queries used are in this session's
history (temp tables `ir_entry` / `scored`, joined `ignition_results` →
`screener_cycles` → `screener_outcomes`).

---

## Other deferred / known

- ✅ Swing debug-log cleanup (2026-06-13; empty-scan warn kept — failure-path
  diagnostic) · ✅ Finviz ~1 req/s recorded in CLAUDE.md · ✅ GitHub Actions
  Node 24 (checkout@v5 + `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, opted in
  ahead of the 2026-06-16 forced default).
- **Deeper Finviz relief:** share the after-hours v=152 quote overlay across
  screens (cuts AH calls ~9→~5/cycle). Non-urgent now that the gate exists.
- **Retune from outcomes generally:** swing alert ≥65, ignition weights,
  dual-signal threshold — all first-pass guesses, now have data to tune.
- Git state at handover: `main` @ `99f3eee`, in sync, clean tree.

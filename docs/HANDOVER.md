# Session Handover — updated 2026-08-06

A running handover so a fresh session can continue without re-deriving context.
**Read `docs/web-dashboard.md` first** (the canonical status doc); this file is
the "where we are right now + what's open" layer on top of it.
**`docs/detection-layers.md` is the systematic reference for the early-
detection chain** (📰/🤫/📈/👀/🛰️ — how each layer works, knobs, grading SQL).
Memory files under `…/memory/` also carry the durable facts.

**CURRENT FOCUS (refreshed 2026-08-06): TWO instruments now. (1) The ↗
price-reclaim layer — reclaim-ONLY on FIVE timeframes — remains the only
Telegram-alerting component, with A+/A/B attention tiers on the ↗ EMA tab.
(2) NEW ⤴ MACD MOMO tab (the DEFAULT view since 08-06, operator's call) —
the operator's actual live strategy automated: second-leg entries on the
session's top gainers via the 3/10/8 all-SMA MACD curl on 5m (they have a
day job, miss the first move, and trade the later legs; playbook = wait for
the pullback reset, enter when the line curls up toward the signal, tight
stop). Display+grading only (tier='macd'), no sounds/Telegram until graded
— see XMOMO below + docs/detection-layers.md ⤴ section.** The 10/65 crossover channel is RETIRED
(2026-07-26, `cross_detect: false` everywhere; machinery kept + tested for a
data revisit). The chain otherwise runs in full (🤫 accum → ↗ reclaim →
👀 watch → 🛰️ confirm → screens; 📰 radar is DARK while Benzinga is parked;
every transition in `tier_events`; sidebar reseeds on boot).
- **↗ reclaim layer, current shape:** price crossing up BOTH EMA 10/65 on
  5m/15m/1h/4h/1d (bars_* warmup stores per tf; 1d on the 04:00-ET day
  grid, intrabar = its real-time path), **arming staged across in-band bars
  (XSTAGE)**, intrabar everywhere with NO stale
  wait (XVTAK), gap-decay on feed-scale bars only — never on consolidated
  replay (XFIEE) — with sparsest-first 2h Yahoo re-anchor whose range
  widens until the bar count clears warmup,
  pend-through-insufficient-evidence in all three shapes (thin sibling
  window / junk-dollar arming bar / decay-flip), basis-break guard ≥4.85×
  evaluated ONLY on the first tick after ≥6h of tick silence (XHYFM — a
  continuous walk to 5× is a runner, not a split; real splits still reset),
  weekend test prints dropped
  live + in backfills, corrupt-source guard (flip-flop + amplitude) → Yahoo
  fallback, split-adjusted seeds bounded to 1–3 day seams. Volume confirm:
  sibling ≥3×/5× + $10k notional ($500 junk floor), OR the
  exceptional-expansion escape (≥30× + ≥$1.5k + sib ≥2× dead-tape floor —
  the GSUN/CYCU/FCUV class; dashboard+grading only, no phone). Confirmed 5m
  rows carry **A+/A/B attention tiers** (A+ = HTF reclaim co-confirm ±2min
  + ≥20× → 32.3% reach +20% same-day; B ≈ the random-bar null → B-rest
  collapses in the UI, B-notable ≥30×/<$2 stays visible). Full spec:
  `docs/detection-layers.md` + `docs/ema-list-optimization-2026-08-01.md`.
- **Alert posture (operator's call):** Telegram = ↗✅ 5m reclaim confirms
  ONLY (`ema_reclaim` slug; HTF reclaims are dashboard+grading — promote by
  deleting one guard line in `pushCrossAlert` when graded). Everything else
  muted via `ALERTS_DISABLED` (the dormant `ema_cross` slug fires nothing).
  Dashboard sounds/title-flash are EMA-only. Alert silence ≠ detection
  failure.
- **Paid APIs parked (2026-07-25):** Benzinga + Anthropic tokens commented
  out in the droplet .env (key presence IS the toggle) — radar dark,
  classification rules-only, news = Finviz/Yahoo/SEC/halts. ~$150+/mo saved;
  re-enable = uncomment + `up -d api`.
- **Feed: Databento EQUS.MINI stays** (07-22 decision). The divergence
  stack is now heavily mitigated (gap-decay, re-anchors, guards) but the
  irreducible residual remains: consolidated-only tape (odd-lot curls,
  VTAK/EDBL premarket) is invisible until real lots print on MINI —
  SIP/PLUS (~$825/mo, via support) is the only true fix.

**THE PENDING TASK — the ~2026-08-12 checkpoint (ten clean sessions from
07-29).** Semantics are FROZEN since 08-01 (the 08-03 guard fix is a
state-destruction bug fix, additive-only, log-identifiable). The checkpoint
runs `apps/api/scripts/research/reclaim-grading.sql` — the cuts are all
committed, definitions frozen in code, baselines recorded in the headers:
q4 session-matched control (standard confirms measured at NO median edge on
2 sessions — does that null hold?), q5+q6 the exceptional-escape cohort
(does its 2.5×-up/1.75×-down asymmetry survive n≈50 + target-before-stop?),
q7 the A+/A/B tiers (does A+ hold ~32% reach-+20 and B-rest stay at the
null? what lands in the collapsed band — UPC-class AH winners?), q8 entry
mechanics (does the 81%-pullback / 2× win-rate result hold?). Decisions
queued for it: **Telegram promotion for HTF-aligned confirms (A+)** — FCUV
and HYFM (+650% each, phone silent) are the exhibits; escape → phone or
kill; the dead-tape conditional floor; per-tf keep/kill. Boundary log for
segmentation: 07-22 10/65 · 07-23 gap-decay+pends · 07-24 reclaim channel ·
07-25 weekend gate · 07-26 reclaim-only+15m/1d · 07-27 guards/no-stale-wait
· 07-28 staged arming + FIEE warmup holes · **07-29 11:16 ET escape
(additive)** · 07-30 OHLC persistence · 08-03 guard tick-silence fix
(additive). Also still owed: (b) 👀 evidence-gate cost audit; (c) accum v2
precision re-check; radar grading moot while Benzinga is parked.

**Recent focus trail** (each has a dated entry below): 08-06 XMOMO (⤴ MACD
3/10/8 curl detector + top-gainers MOMO tab, now the default view —
replay-validated on the 08-05 leaders before wiring) · 08-03 XHYFM (the
basis-break guard wiped a +650% runner mid-run → guard now first-tick-after-
silence only; suite 40 scenarios) · 08-01/02 XTIER (A+/A/B attention tiers,
display-only, from the codex study + 3-session cross-validation) + the
entry-mechanics study (pullback comes 81%, runaways 2/48 — the playbook) ·
07-30 XGRADE (first production review: no median edge for standard confirms
vs session-matched control; OHLC persistence + 45d retention shipped;
semantics FROZEN) + XDASH2 (alerts-mute was never wired; CYCU news-retry;
day change% on rows) · 07-29 XFLOOR (the GSUN escape + 'no in-flight
predictor exists' — do not build about-to-confirm tiers) + the ◆ moving
retier + WLDS display starvation fix + /latest DB fallback + the 4GB
resize after the 1d-refetch swap storm · 07-28 XFIEE (the
trickle-tape day: a +156% run the 5m layer could not see — below-warmup
reseed hole, calendar-vs-bar-count fetch window, gap-decay on consolidated
replay) + XSTAGE (staged arming) · 07-27 the shakedown
day — XSPLIT (FFAI split phantom → basis-break guard + weekend-clean
backfills) + PFSA (guard calibrated to real doublers; corrupt mixed-scale
source → guard) + XVTAK (reclaim intrabar drops the stale wait) + XEDBL
(junk prints can't disarm the reclaim; amplitude corrupt-guard) · 07-25
SPRO (NASDAQ-qualified TV links) + weekend test-print gate + Benzinga/
Anthropic parked · 07-26 XRCL2
(crossover retired — reclaim-only; + 15m & 1d layers) · 07-24 XRECL (↗
price-reclaim parallel channel — the operator's TV price-crossing alert
pair; A/B vs the crossover via tier_events meta.signal) · 07-23 XGAPD (the
CPHI 15-min lag: gap-decay to TV-parity EMA horizons on sparse tapes +
thin-sibling pend/intrabar conversion + warm-sparse Yahoo re-seed; clean
grading segment moves to 07-24) · 07-22 XTAPE (the
thin-tape day: LICN/LBTYK/SKYQ/FAC/ZBAO classes each got a mechanism; feed
decision = stay on MINI) + XNEWS (news on cross rows) + XALRT (EMA-only
alert surface, phone+dashboard+title) + 10/65 params & 30-min cooldown ·
07-21 EMAX (📈
configurable intervals + 1h layer, per-tf UI sections, hideable LIVE
TICKS/ignition, golden EMA test + ema-debug endpoint) + ALRT
(ALERTS_DISABLED env + 📰 radar toggle) · 07-17 X4H (📈 4h
cross layer — operator's swing-timing tool, dashboard-only) · 07-16 XINTRA
(📈 intrabar TV-parity — the ~5-min lag closed) + XMETA (📈 hardening:
Databento backfill, cooldown re-arm, notional floor, gradable meta) · 07-15
SEEDT (state survives deploys) + XCROSS bar-close timestamps · 07-10 📈 XCROSS layer +
NEWSDAY (🔥 icons no longer vanish at midnight ET) · 07-08 ACCUM2 (detector-side
🤫, the SLS case) · 07-07 first live scorecard → TIEREV (tier_events), TICKW-EV
(👀 evidence gate), radar LULD filter, accum v2 (persistence + news-gated push) ·
07-05 QVOL (🤫 measured+shipped) + EMAMACD2 (EMA/MACD book CLOSED — twice-
measured no edge; the 📈 layer is cross-as-NOMINATOR only, volume confirms) ·
07-03 NR (📰 radar) · 07-02 TICKW (two-tier watch/confirm) · 06-21 TJ (Trade
Journal; **attribution join still the open payoff**) · 06-17 tick feed go-live.

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

XMOMO. **⤴ MACD momentum-curl layer + top-gainers MOMO tab — the operator's
live strategy automated (2026-08-06).** The operator explained how they
actually trade around their day job: pick the session's top gainers, watch
the MACD 3/10/8 (all-SMA, histogram off) on 5m, enter when the line turns
up toward its signal after a pullback reset — "close to the crossover",
tight stop — because leaders make several big moves per session and they
always miss the first. Showed five 08-05 leaders (ZYBT/YXT/INLF/RITR/BJDX)
all carrying the same signature, with their INLF entry marked ~10:30 ET.
**Measured before wiring** (the operating norm): pulled the five names'
banked bars_5m from prod, built the pure detector, replayed — SETUP fired
at their exact marks: INLF 10:35 ET → +47%/60m, ZYBT 11:00 ET → +136%/30m,
YXT 13:40 ET → +63%/60m, RITR 10:55 ET at the base of a +29% run; BJDX's
premarket gap-open leg not catchable (the known gapper ceiling). Raw rate
~8 setups/name/session with real −10..−30% failures between → shipped as
an attention surface, NOT an alert: no Telegram, no sounds (operator chose
"tab only, decide after replay/grading"). NOT the twice-closed EMAMACD
book: universe conditioning (already a top gainer) is the point, and it
matches the entry-mechanics result (pullback 81%, pullback-hold 2× win
rate). **Built:** `services/macd-curl.ts` (SETUP = ≥2 rising line closes +
gap ≤65% of episode max + dead-chop floor 0.3% of price, re-arm on broken
curls; CROSS; closed-bars-only = TV parity with the operator's
"Wait for timeframe closes"); fed from the same known-runner 5m bar-close
callback the EMA layer banks + boot-seeded from the same split-adjusted
bars_5m replay; universe top-10 (≥10% floor) ∪ chg≥30, sticky per ET day,
gated in the poller so tier_events grades exactly the displayed
population; `tier='macd'` setup/cross events (fades display-only) with
reseed-on-boot; ⤴ MOMO tab as the new DEFAULT view (operator's call) — one
row per leader: curling (pulses fresh) / crossed / turning / cooling /
warming, gap%, <0 reset badge, setup/cross ago, news badge, full-day chg%.
Verify: `scripts/verify-macd-curl.ts` S1–S7 (incl. the honest edge: a
vertical V-recovery has no curl phase and legitimately goes straight to
CROSS); replay harness durable at `scripts/research/macd-curl-replay.ts`.
**Freeze untouched:** reclaim semantics/alerts unchanged; this is a new
parallel display layer. **Next:** grade setups after ~a week
(below_zero × chg band × time-of-day vs same-name non-setup bars) → decide
the gated Telegram subset (first-setup-of-day / <0-only are the candidate
dials).
**Same-day fix (the LPSN/WYHG lag, operator's first live check):** the tab
rendered state as of the last CLOSED bar, and a bucket only closes when the
NEXT trade lands on MINI — so thin premarket tapes lagged the operator's TV
panel by minutes (LPSN read "crossed" through a visible roll-over, WYHG
"turning" after TV's line had hooked above; XCH/MGRX/SURG matched, incl. a
live ✚ stamp on XCH). Display state now folds the LIVE screen price
(consolidated tape, no MINI blindness) into the rings as the forming bar —
provisional line/signal exactly as TV draws its panel. DISPLAY ONLY: events
and committed state stay closed-bar, grading unaffected. Off-screen sticky
names (no live price) fall back to closed-bar state with an honest ⏱Xm
staleness chip at ≥10 min.
**Round 2 (same evening, LPSN/GVH again — the MULTI-BAR hole):** one folded
bar can't represent a multi-bar fade the MINI feed never banked. Verified
on prod: LPSN's last banked 5m bar was TWO HOURS old (a 1-share $2.40
print) through its whole consolidated dust-print fade to $2.27; GVH had the
spike bars but none of the 3-bar dump to $0.88 — so the ring stayed full of
stale spike closes and both read green "crossed" against a TV panel well
below the signal. The fold now synthesizes EVERY missed in-session bucket
between the last real bar and now (flat carries at the live price, capped
at one full ring refresh — the gap-decay idea applied to SMA rings), which
converges the line to where a tape sitting at the live price puts it;
nights/weekends synthesize nothing (TV holds its panel across the close);
`rising`/'turning' can no longer be claimed across a synthesized hole
(fixes MGRX/AZI showing "turning" while TV's line fell). Off-screen names
fall back to the 5m EMA tracker's OPEN-bucket price before going
closed-bar; the ⏱Xm chip now keys on minutes-since-last-REAL-print
regardless of the fold. Verify suite → S8 (stale-hole convergence +
closed-session no-wash). WYHG meanwhile produced the first fully-live
staircase on the tab: ⤴ setup 6m → ✚ cross 55s at +106%, and CLRO's ✚30m
stamp sat at the base of its $7→$12 leg (+197%).
**Round 3 (operator's ask): below-zero resets rank first + real <0 badge.**
Sort is now state ladder (⤴ curling → ✚ crossed → turning → cooling →
warming) → **<0 first within the state** → day-chg desc. For CROSSED rows
the flag is stamped at the cross EVENT (origin) — the live line rises
through zero as the leg runs, which would strip the badge exactly when the
thesis works; other states read the live line. The <0 marker became a
bordered badge on every state (was tiny text, hidden on cooling).
Display-only; meta.below_zero already carries the grading cut. **Day-1
tally (first full session):** 24 setups / 53 crosses across ~20 qualified
leaders — 21/24 setups below-zero (the announce-worthy curl IS mostly the
deep-reset class, consistent with the operator's read). WYHG closed the
loop: setup→cross staircase fired live at +106%, ran to +565% same day.

XHYFM. **The basis-break guard wiped a +650% runner mid-run — guard now
tick-silence-gated (2026-08-03).** HYFM: dead tape at $0.55 for weeks, Monday
vertical to $4.08. The layer's best catch to date — 1h instant-confirm
$0.7501 (36×) intrabar ON the ignition bar, 15m+4h 99s later, TV's own EMA
pair at $0.678/0.684 — then at 07:34 the FFAI split guard read the CONTINUOUS
walk $0.551→$2.71 (4.92×) as a reverse split and deleted ALL FIVE layers'
state mid-run. Worse: the backfill re-seeded on the old basis and the next
tick re-broke it ($0.551→$3.37) — a loop that kept the symbol blind all day.
Third specimen (STKH 4.87× reset the 1d on 07-27's own ship day; PFSA/LGHL
forced the same-day 4.85× recalibration). Root cause: the guard compared
EVERY tick against the last COMMITTED close — which on Monday morning is
FRIDAY's (the open bucket never commits until the next bucket's tick), so a
runner walking up in prints minutes apart was tested against a 3-day-old
basis until one print crossed 4.85×. A basis break physically manifests on
the FIRST print after a gap; a continuous walk cannot be a split. Fix: the
guard now evaluates ONLY on the first tick after ≥6h of TICK silence, with
tick recency in a map OUTSIDE the resettable state (so a legit reset cannot
re-break on the post-reseed tick). FFAI protection intact (S32); S40 pins
the walk survival + no-re-break-loop. Suite → 40 scenarios.
⚠️ Shipped DURING the freeze as a state-destruction bug fix (operator's
call, AskUserQuestion 08-03): it prevents false wipes on the ≥4.85× runner
class — additive-only, affected names identifiable via the basis-break log
lines; grading can segment. Also on the record: HYFM produced ZERO phone
alerts (Telegram is 5m-confirm-only; the 5m likely pended on a thin sibling
and died in the wipe) — with FCUV that is two +650% names where HTF
alignment was the signal; the strongest exhibit yet for the checkpoint's
Telegram-promotion question. 5m never fired: not provable post-wipe (pends
are not persisted).

XTIER. **↗ 5m attention tiers A+/A/B — display-only (2026-08-01, codex
study + Claude cross-validation).** Operator: "too many 5m confirms, most
move <10-20%, a few (FCUV/DFNS/CYCU) are huge — can we optimize the list?"
Two independent analyses converged: codex found **HTF co-confirmation within
±2 min** is the primary axis (its no-HTF cell: 0.8% tail on 2 sessions);
Claude's price×ratio cells + audit found ratio≥30/price<$2 as secondary axes
and corrected codex's recall (10/11 was a 2-day artifact — the 07-29 session
held 5 more winners, NONE with HTF co-confirms, incl. NCRA +147% @133×).
3-session validation: **A+ (HTF+≥20×) 32.3% reach +20% same-day · A 10.0% ·
B 3.6% ≈ the random-bar null (2.5%)**. Shipped: poller stamps
`priority`/`co_tfs` on confirmed 5m reclaim rows (derived each cycle from
confirmed_at in the display map — late HTF confirms promote automatically,
no new state); UI shows A+/A chips with tf badges, collapses **B-rest**
(not notable: ratio<30 AND ≥$2) behind a "show all" toggle. Visible set
keeps 14/18 winners (78%) at ~60% list reduction. Ordering stays
newest-first (the WLDS lesson — tier-first would re-bury fresh reclaims);
DFNS on the record as never-capturable (confirm at +197% into its day;
day-chg% is the guard). Grading: query 7 in reclaim-grading.sql cuts the
exact tiers; checkpoint question = does B-rest hold at the null while A+
holds its rate, and what lands in the collapsed band. Addendum with the
recall correction appended to docs/ema-list-optimization-2026-08-01.md.
NO detection/alert/semantics change — the freeze holds.

XDASH2. **Four operator-reported dashboard fixes (2026-07-30 evening).**
All display/enrichment only — detection, confirm rules and alert eligibility
untouched, so the grading freeze and clean segment hold.
1. **The Alerts ON/OFF button never muted anything.** `AlertsToggle` wrote
   `localStorage['alerts.armed']` plus its own component state and NOTHING
   read either; `useScreenerAlerts` ran unconditionally from DashboardPage.
   Pressing OFF changed the label and colour while every confirmation kept
   beeping — there was no mute to fail, it did not exist. New
   `hooks/useAlertsArmed.ts` is the shared reference (custom event for
   same-tab, `storage` event for other tabs; device-local because arming also
   unlocks this browser's AudioContext). The mute is enforced INSIDE
   `beep()`/`notify()`, not at the ~12 call sites, so a future alert type
   cannot bypass it; the gate is mirrored during render because an effect
   would leak one beep on the muting cycle. ⚠️ Behaviour change: sound is now
   genuinely gated on armed, where before it played whether or not the user
   had ever armed. **Operator to verify the mute in-browser (owed).**
2. **Cross rows never showed news (the CYCU case).** `enrichCrossNews` set
   the cache to null as a stampede claim and never invalidated it, so "no news
   yet" became permanent for the ET day. CYCU's cross fired 08:20:14; Finviz
   did not carry its $54.6M contract PR until 08:23 — the row stayed newsless
   through a +274% day, three minutes short. That ordering is the layer's
   PREMISE (reclaim precedes headline), so one lookup at nomination is
   structurally too early. Now retries 3x/10min while the row is <45 min old,
   driven from the payload build because a ticker whose only cross preceded
   its headline has no later event to trigger one. Was 131 of 145 rows
   newsless. **Real test is tomorrow's open.**
3. **Day change% on every reclaim row.** The tick feed already holds a prior
   close for every subscribed symbol, so this was a lookup, not a fetch.
   Coverage went 16/126 → 109/109 after falling back to the tracker's
   `lastClose` (bucketClose is 0 until a symbol ticks, and the boot seed
   replays closed bars only, so after every deploy the panel went blank for
   anything not currently trading). Confirmed rows now show a LIVE price too —
   a frozen confirm price beside a live change% was incoherent.
4. **⚠️ The EMA change% anchor differs from the screener's, deliberately.**
   `fetchScreener`'s v=152 overlay replaces Momentum/Ignition `change_pct`
   with Finviz's AFTER-HOURS change (since the 4pm close) in the afterhours
   session ONLY. EMA rows stay FULL-DAY in every session — extension is what
   the panel judges. Measured divergence 2026-07-30 AH: CYCU +888% vs +63%,
   GCTK +240% vs +25%, MGRX -10% vs +67%, with prices agreeing (only the
   anchor differs). Operator's call to label rather than converge: tooltip
   states the anchor and warns in AH; a superscript "d" marks the divergent
   session. Precedent: ScreenerPanel already retitles its own column "AH Chg %".

XGRADE. **First production review of the reclaim layer — and the evidence
plumbing it exposed (2026-07-30, codex investigation + review).** Full doc:
`docs/reclaim-strategy-investigation-2026-07-30.md`; reproducible cuts:
`apps/api/scripts/research/reclaim-grading.sql`.
**The headline result, after correcting the method twice.** The doc first
reported post-confirm follow-through in ABSOLUTE terms (median 30m MFE
+0.38%), which reads as failure; a null baseline was missing. Adding a
random-bar control put the tail lift at 2.9× — but that control spanned
04:00-19:00 ET, comparing regular-hours confirms against quiet premarket/AH
bars. **Session-matched and bootstrapped (4 draws, stable ±0.1pp), regular
hours only, 60m:** confirms n=80 vs control n≈1,900 — median MFE +0.62% vs
+0.63% (**no median edge**), mean +1.45% vs +1.17% (1.2×, not 2.9×), reached
+5% 8.8% vs 4.3% (**~2.0×**), fell <=-3% **35.0% vs 15%** (**~2.3× worse**).
So the 5m confirm is a **volatility selector whose raw skew on closes runs
slightly AGAINST you**, not the favourable asymmetry an unmatched control
suggested. ⚠️ Evidence quality is lopsided: the downside amplification is
solid (28 of 80 vs ~12 expected, z~5) while the upside rests on 7 events
(z~2, one session) — **the adverse selection is established; the tail benefit
that would justify it is not.** Whether the layer is tradeable now hinges
entirely on ORDER OF ARRIVAL (can a tight stop execute before the favourable
excursion?), which close-only bars cannot answer.
**Also measured:** extension already paid between reclaim and confirm —
median +0.74%, p90 +5.41%, i.e. the confirmation wait consumes roughly half
the median move. And higher absolute notional did NOT rank follow-through, so
the $10k floor is not a quality filter (which weakens the case against the
escape rather than for raising the floor).
**Shipped (instrumentation only — semantics FROZEN):** (1) `bars_5m` gains
nullable **open/high/low** (migration `20260730100000`) — the sidecar already
emitted o/h/l/c/v and onBar already parsed them; they were dropped one line
later. Accumulated in tickfeed and attached in the bar-close callback, so
`ema-cross.ts` is untouched (threading h/l through addBar would change a
signature the whole verify suite depends on); EMA math still reads
close/volume only. (2) **Retention 6d -> 45d** — at 50 MB per 6 days the old
window pruned the early sessions of a ten-session review before they could be
graded; raw bars kept deliberately instead of a pre-computed outcome table so
later questions can use metrics nobody has thought of yet.
**NOT changed, deliberately:** EMA 10/65, staged arming, observation windows,
the $10k floor, `exceptional_vol_x`, volume ratios, Telegram eligibility.
**Next checkpoint:** ~3 sessions for a direction check, ~10 for thresholds.
Owed: stable `observation_id` in meta (removes fuzzy temporal joins — deferred
to its own change rather than stacked on this one), and the target-before-stop
grid (query 6 in the grading script, live from 07-30 bars onward).
⚠️ **Deploy discipline:** no routine API deploys 09:30-16:00 ET — a restart
drops in-flight 5m observations (one of mine killed GSUN's 5.7 min into its
window). This change went out 06:35 ET premarket at a measured cost of 7
in-flight 5m rows (~0.7 expected confirms) to buy a full session of OHLC.

XFLOOR. **The GSUN escape + the 'no in-flight predictor' result
(2026-07-29).** Two findings from the operator working the new EMA tab live.
(1) **GSUN**: 5m reclaim nominated 09:52 at $0.191 on a **55.5×** volume
bar — the strongest evidence the layer can see — but at $0.19/share that is
$1,909, under the flat $10k confirm floor, so no confirm and no alert while
it ran to $0.29 (+52%). The floor is price-blind and a sub-$1 name cannot
clear it on a 5m bar however violent the burst. Measured before changing
anything: confirms sit at p10 $10,313 / median $14,461 (the floor IS the
gate) but the median NOMINATION bar is $1,161 (the floor earns its keep) —
dropping it to $2,500 admits ~150/day vs ~86/day today. Shipped instead as a
bounded escape: **ratio ≥30× AND ≥$1,500 AND sib_median ≥2× the dead-tape
floor** (~7/day). The verify suite caught the flaw in a ratio-only version:
a ratio is most inflated where the baseline is DUST (S26/S29's 10-share
median makes any bar 300×), so it would have confirmed exactly the dead-tape
trickles the operator chose to keep nominate-only (PBM). ⚠️ Dashboard +
grading only, no Telegram (X4H precedent) — they are the confirms with
`meta.notional < 10000`. Suite → 39 scenarios.
(2) **No in-flight predictor exists.** A 'holding' tier shipped that morning
lit 32 of 40 rows on the 5m lane; measuring properly showed why nothing
could work: confirmed vs expired observations differ by only 1.4× on price
(median +0.65% vs +0.44%), volume ratio is circular, and the confirm hazard
is FLAT in age (~2%/bucket, 89.5% never confirm). Retiered as descriptive
`◆ moving` (live price ≥3% off the reclaim, ~6% of rows). **Do not build
another "about to confirm" tier** — it is the founding result restated.
Also this session: the ↗ EMA tab (five lanes, default view, caps
40/30/30/25/20), rows refreshed live with % since reclaim, `/latest` DB
fallback so a reload paints in ~4s instead of ~39s, and the confirmed-first
sort replaced (it was starving fresh reclaims out of view entirely — 11
confirmed rows alive against a cap of 10 meant observing rows got ZERO
slots).
⚠️ **A mid-session deploy costs in-flight 5m observations** — GSUN's died
5.7 min into its window when the API restarted. Reseeded 5m observing rows
are dropped by design; prefer deploying outside 09:30-16:00 ET.

XFIEE. **The FIEE miss — THREE stacked holes, all in the 5m layer's ability
to see a trickle tape (2026-07-28, operator-caught).** FIEE ran +156%
(~$2.75 → $10.33, 10:35–11:30 ET); only the 1d (11:24, $7.04) and 4h
(12:00, $8.37) layers fired. Operator asked why the 5m didn't, pointing at
a visible reclaim on their chart. `ema-debug` gave the first answer:
**`ema_slow: null` — the 5m and 15m trackers had never warmed** (30 and 39
bars vs 65 needed), so those layers were structurally incapable of firing,
which from the outside is indistinguishable from the documented
already-above-the-stack blind spot. Three independent causes, each fixed:
(1) **The below-warmup backfill threw its own data away.** It fetches
history, then seeds only `if (canSeed)` — false the moment a symbol has
produced one live bar. A trickle name streams a few bars a day, so it was
never seedable, and the sparse re-seed (which HAS the
`reseedFromHistory` fallback) explicitly required past-warmup names.
FIEE sat in the gap forever. Now the below-warmup path reseeds too, and
the sparse sweep's past-warmup floor is gone.
(2) **Warmup is a BAR COUNT; the fetch window was a CALENDAR window.**
`fetchYahoo5m` asked for `range=5d`, which assumes ~192 buckets/day of
prints — FIEE's entire consolidated week was 86 bars. No number of retries
could ever reach 65. The range now escalates 5d → 1mo → 60d until the count
clears 2× warmup (FIEE: 86 → 178 → 688). Dense names never escalate.
(3) **Gap-decay was being applied to CONSOLIDATED replay history — and it
un-armed the channel.** Decay exists to synthesise bars our MINI subset
missed but the consolidated tape carried (CPHI). A consolidated series has
none to synthesise: its holes are the MARKET's, and TV decays nothing
between prints either. Compounding hundreds of phantom steps on a thin
name dragged FIEE's EMA65 to **2.77 vs TV's 3.67** — below the price, so
the channel was never armed. Decay is now skipped when replaying a
consolidated series (feed-scale history still decays; CPHI intact, pinned
by S38). Measured on FIEE's real tape: seeded EMA10 2.88 / EMA65 3.45 vs
the operator's TV 3.01 / 3.67, **armed=true** — vs `null` before.
Also shipped alongside: **staged arming** (see XSTAGE) and **sparse-sweep
ordering by 24h density** instead of pure staleness — stalest-first
assumed a fresh newest bar means the live tape is self-correcting, but a
trickle name prints every ~20 min: always "fresh", never dense, and FIEE
sat behind ~800 staler names on the day of its burst. Sorting on last-24h
bar count keeps the OMH lesson for free (a silent name has n24 ≈ 0 and
still sorts first). Suite → 38 scenarios / 128 checks. New durable tool:
`scripts/research/reclaim-staged-arming-replay.ts TICKER` replays any
name's real consolidated tape through old vs new semantics.
⚠️ **The clean grading segment moves to 2026-07-29.**

XSTAGE. **Staged reclaim arming — the staircase curl (2026-07-28).** The
arming was a single-bar flag: prev close ≤ BOTH EMAs, else disarmed. So the
channel only fired when both crossings landed on ONE bar — but TV evaluates
the operator's two "Crossing Up" alerts INDEPENDENTLY, and real curls stage
them. FIEE cleared EMA10 at 10:35 ET and EMA65 twenty minutes later; every
in-band bar between them killed the arming. The arming now survives up to
`staged_arm_bars` closed bars spent inside the band (5m/15m 6, 1h 4, 4h/1d
3), and is cleared by a close above both (the fire) or by running out of
staging. `staged_bars` rides in every reclaim event and in tier_events meta:
**0 = a fire the old semantics would also have made, >0 = a staircase only
this catches** — grade the two populations separately before promoting
anything to Telegram, since this widens nomination (the volume-confirm
funnel is untouched, so the alert surface stays gated). S28 was rewritten
(it asserted the old exclusion), S36/S37 pin the new contract. Honest
scope note: on FIEE itself the warmup/decay fixes were the load-bearing
ones — with a warm tracker the layer fires at 09:45 either way; staged
arming adds a second, later nomination. Its justification is the general
shape, not this one case, which is exactly why it ships instrumented.

XEDBL. **Junk prints can no longer disarm the reclaim + amplitude guard
(2026-07-27 afternoon, both operator-caught).** (1) EDBL burst +140% at
08:16; only the 4h + tick tiers fired. The operator's 2m zoom showed
prior pops over both EMAs at 06:42/07:00 — those were 2-15 SHARE prints
($7-50): the junk floor rightly refused to nominate, but the bars still
closed above the stack and flipped prevBelowBoth — dust consumed the
arming, so the real burst found 5m/15m/1h disarmed. Now a coherent
junk-dollar bar closing above both EMAs PENDS (pendingR, anchored there)
and converts intrabar when dollars arrive; outlier junk still discards
(S35). (2) EDBL's 4h slow EMA read $4.3M — a single off-scale poison
print in a fetched series slips past the flip-flop corrupt test; the
guard gained an amplitude criterion (any bar ≥20× off the series median
→ corrupt → Yahoo fallback) and 751 zero-volume spike bars were purged
from bars_4h across ~10 tickers. Suite → 35 scenarios / 115 checks.

XVTAK. **Reclaim intrabar drops the stale-EMA guard (2026-07-27,
operator's call — the VTAK cost).** VTAK's 2482× burst confirmed at
08:05:09 — the first bar CLOSE — because the stale guard suppressed
intrabar detection after hours of MINI silence, costing ~4 min on top of
the tape-visibility gap (MINI saw NOTHING of the 07:40-08:00 consolidated
curl; first banked bar WAS the burst bucket). The guard predates
gap-decay, which keeps EMAs honest through silence — a resume print
clearing the decayed stack IS the quiet-curl signal. Removed for the
reclaim intrabar path only (cross path unchanged); PBM-class dead-tape
⚠️ rows fire minutes earlier intrabar, same floors/containment. S34.
⚠️ Reclaim semantics changed again → its clean segment starts 07-28.
Residual VTAK-class lag (~5 min of consolidated-only curl) is the feed
boundary — SIP/PLUS remains the only true fix.

XSPLIT. **The FFAI split phantom — basis-break guard + weekend-clean
backfills (2026-07-27, Monday premarket).** The 1d layer's FIRST live fire
was a phantom: FFAI reverse-split (~1:90) effective Monday; our daily EMAs
sat on the old basis ($0.13/$0.28 vs Friday's $0.074 close) and the first
post-split print at $6.95 "reclaimed" both by 25×. Two root causes, both
fixed: (1) **basis breaks** — `EmaCrossTracker.addBar` now detects
split-like overnight jumps (mirrors adjustSplitHistory: ≥4.85×
unconditional, 1.94–4.85× near-whole, symmetric for forward splits,
same-session moves exempt) and RESETS the symbol's state — warmup blocks
events until the backfill reseeds on the new basis; better an hour blind
than a phantom (S32). (2) **Saturday test prints leaked via the HISTORICAL
path** — the live-sidecar weekend gate can't help a backfill; Sat pre-04:00
ET test prints landed inside Friday's still-open DAILY bucket (FFAI's
Friday bar banked as $6.50) — all three historical fetchers now drop
ET-weekend source rows. Cleanup: bars_1d TRUNCATED for a clean rebuild
(the Friday-bucket contamination class isn't row-filterable), FFAI's
phantom event deleted (SDOT's too — overzealous: its banked basis was
already post-split, that reclaim was likely real). 1d layer re-warms over
~1h Monday morning; suite → 32 scenarios / 108 checks.

XRCL2. **Crossover retired; reclaim-only on FIVE timeframes (2026-07-26,
operator's call).** After three days watching both channels live, the
operator kept the ↗ price-reclaim and killed the 10/65 crossover as a
nomination source — `cross_detect: false` on every config (the machinery
stays intact + tested via CROSS_ONLY/BOTH_ON in the verify suite; a data
revisit is one flag; historical tier_events stay interpretable —
meta.signal absent = cross). ⚠️ The planned cross-vs-reclaim A/B is MOOT
— the grading pass becomes reclaim precision per timeframe. Also added
**15m** and **1d** reclaim layers (operator's ask): htfLayers now
15m/1h/4h/1d + the bespoke 5m — new `bars_15m` (12d retention, Databento
ohlcv-1m, Yahoo 15m×60d fallback) and `bars_1d` (260d retention,
ohlcv-1h re-bucketed to the 04:00-ET day grid via `etDailyOffsetSec`,
Yahoo 1d×1y fallback; deepDays 160 is the convergence skip — minBars 200
would mean 10 months). A 1d bucket only closes on the next day's first
print, so intrabar is the real-time path (the point). Telegram: reclaim
confirms still 5m-only. Suite → 31 scenarios / 105 checks (S30
prod-configs-are-reclaim-only, S31 new-grid tf stamping; S12/S15/S27
pinned to cross-enabled variants). ⚠️ First boot pays the 1d Databento
pass (~1,500 syms × 240d ohlcv-1h, metered — larger than the 4h pass,
one-time); 15m/1d layers warm from backfill — grade them from
convergence, not from deploy time.

XRECL. **↗ Price-reclaim channel — the operator's TV "price Crossing Up
EMA(10) AND EMA(65)" alert pair, as a PARALLEL nomination channel
(2026-07-24).** Operator asked to detect the AND-ed price-crossing
conditions "instead of" the crossover; measured first (4d banked bars,
$500 floor): reclaims fire ~1.6× the crossover's raw rate and only 11%
of reclaim bars coincide with a crossover bar — a different event set
(pre-crossover precursor / post-crossover pullback-reclaim). Recommended
parallel over replacement (the crossover's clean segment started 07-24
same day); operator agreed. Built: reclaim detection in the tracker
(prev close ≤ both EMAs → price > both; intrabar + closed-bar; SEPARATE
watchR/confirmedTodayR/lockedUntilR so the funnels never gate each other
— cross semantics untouched, its segment holds), same volume-confirm
rules/floors/stale-guard, thin-sibling skip (reclaims re-arm naturally,
no pend), events tagged `signal:'reclaim'` via a drain queue (cross keeps
addBar's return). Poller: rows/dedups key `${tf}|R|${ticker}` (cross keys
unchanged → reseed continuity), tier_events meta.signal (the A/B cut),
new `ema_reclaim` Telegram slug (independent of ema_cross; headline
"↗✅ PRICE RECLAIMED EMA 10+65"), reseed carries signal. Web: blue ↗ tag
+ "reclaim Xm ago" rows; alert/title-flash keys include signal.
Same-day follow-up: HTF enabled too (`reclaim_detect` true on 1h/4h —
measured raw rates 1h ~200-270/day, 4h ~60-110/day, both ~1.7-1.8× their
crossover) with reclaim Telegram gated to **5m only** (X4H precedent;
full-tf pushes would add ~50-85/day on the 1h 20-27 / 4h 8-23
cross-confirm baseline — dashboard rows + tier_events grade all tfs).
Suite → 29 scenarios / 101 checks
(S27 funnel+independence, S28 arming rules, S29 pending reclaim); legacy
scenarios pinned to CROSS_ONLY config so the cross channel stays tested in
isolation. **Same-day fix (the AMIX burst):** v1 SKIPPED thin-sibling
reclaims ("re-arms on the next dip-below-both") — but a vertical ignition
never dips back: AMIX's burst met the reclaim condition on a 42-share
sibling window; the cross pended through it (CPHI mechanism) and confirmed
92×, the reclaim stayed silent and missed the move (1h reclaim caught it
at 470×). Reclaims now PEND on thin windows + convert on dollars
(`pendingR`, dies at any close back inside the stack) — mechanism parity
so the A/B compares signals, not plumbing. ⚠️ reclaim semantics changed
→ the reclaim channel's clean segment starts 2026-07-25 (cross untouched,
its segment stays 07-24).
**Grading:** both channels grade from tier='cross' segmented on
meta.signal (absent = cross); compare nominate→confirm + forward outcomes
after ~a week, then keep/kill/expand-to-HTF.

XGAPD. **The CPHI 15-minute lag → gap-decay: TV-parity EMA horizons on
sparse tapes (2026-07-23).** Operator: "why 18:50, not 18:35?" — their TV
10/65 alert fired ~09:35 ET, ours 09:50:53 at $2.04 (the top of the move).
Root cause was NOT a guard or a missing print: our closes matched TV's
bar-for-bar, but 65 bars of MINI tape reach back DAYS (CPHI banks ~55
bars/day; the **median tracked name banks 33/day, 81% < 55** — CPHI is the
NORM, not an edge case), so our EMA65 still remembered Monday's $2.20 tape
($1.88) while TV's dense consolidated series had decayed to $1.74. Fix
shipped in three mechanisms (all timeframes, kill switch `gap_decay`):
(1) **Gap-decay** — every empty in-session bucket folds the last close into
the EMAs exactly as if a flat carry bar printed; computed lazily in closed
form on the next tick (no timers, no synthetic bars in state/warmup/
siblings/persistence; seed replay applies the same rule → live and reseeded
state stay bit-identical; nights/weekends decay nothing, like TV). A
fast-over-slow flip DURING a gap parks a PENDING quiet-curl cross at the
carry price — the ZBAO mechanism reused. (2) **Thin-sibling pend + intrabar
conversion** — the decayed CPHI cross landed where the sibling ring (days of
junk prints, median ~40 sh) sat under the 50-sh dead-tape floor, which used
to consume the cross SILENTLY; a real-dollar cross over a dead window now
pends, and ALL pendings convert INTRABAR the second bucket dollars
accumulate (monotone-volume soundness; conversion gated on the provisional
diff so a crashing tick can't convert a dying cross). (3) **Warm-but-sparse
consolidated re-seed** — the Yahoo fallback only rescued below-warmup names
(CPHI's 329 banked bars = "warm"); now names under 120 banked LAST-24H bars
(`SPARSE_5M_MIN_BARS_24H`) get their EMA state rebuilt from Yahoo's
consolidated tape via `reseedFromHistory` (refuses mid-observation, keeps
day flags + the feed-scale sibling ring; most-recent-active first, 400/scan
cap, deferrals logged), and the HTF backfill gained the same warm re-seed
(CPHI 1h: EMA65 2.73 vs fast 1.92 — a weeks-deep horizon).
**Same-day follow-up (the RELL/LFMD report, operator's TV check):** the
first cut re-seeded once/ET-day and persisted the Yahoo bars — wrong twice:
path divergence re-accumulates within HOURS on MINI-quiet names (RELL
re-fired a morning TV cross as "fresh" at 12:50; LFMD crossed while TV's
fast sat 3% below its slow — its confirm did catch a real +5% pop, for the
record), and persisted Yahoo bars made swept names read "dense", excluding
them from later sweeps for days. Now: **2h per-symbol retry** (HTF's
pattern), criterion = last-24h banked density, **no persist** from the
sparse path; **ordering flipped to stalest-first 07-24 evening (the OMH
lesson)** — MINI was blind through OMH's entire premarket (no prints
18:30 ET → 09:20 ET) while consolidated dipped below the stack and
re-armed both TV signals; OMH sat behind 912 fresher names in the sweep
queue and 4 deploys kept resetting the in-memory retry map, so its slot
never came before the +100% burst (the 4h reclaim + tick ladder caught
it). Stalest banked tape = blindest = first; deploy resets become
harmless. Known transient documented: a deploy boot re-derives all EMA
state → a burst of nominations in the first minutes (8 of 10 sidebar rows
fired ≤8 min after the 07-23 16:44 boot) — one-time per deploy, volume
stage disposes. First sweep on prod: 374/400 re-seeded + 834 deferred;
1h warm-reseed 108/109, 4h 360/361. **Verified:**
replay of CPHI's real banked bars → pend 09:30–35, nominate 09:35 @$1.73,
confirm 09:40 intrabar (vs live actual 09:50:53/$2.04) — the TV alert
matched; suite now 26 scenarios (S22 decay≡flat-fill parity, S23 in-gap
flip→pending→dollars, S24 closed-session no-decay, S25 warm re-seed
contract, S26 dead-sibling pend/convert; S1–S21 unchanged — the default sim
epoch is a Sunday, so pre-decay scenarios keep exact semantics). ⚠️ ratio
meta on thin-sibling conversions is inflated (vs a junk median — CPHI reads
91×/890×); `sib_median` rides in meta and the thin-tape ⚠️ still marks the
rows — segment in grading. ⚠️ **Cross semantics changed again → the clean
10/65 segment starts 2026-07-24.** Deferred: Databento EQUS.PLUS historical
polling (consolidated intraday top-ups, metered cents) if grading still
shows residual divergence.

XTAPE. **The thin-tape day (2026-07-22 afternoon): the operator stress-tested
the EMA layer against TV all day; every miss traced to ONE root — EQUS.MINI
is a subset tape — and each manifestation got its mechanism.** The chain:
(1) **LBTYK phantom** — 1-share $11 odd-lot print +10% off market nominated;
SIP excludes odd lots so TV never saw it → `nominate_min_notional` junk
floor, calibrated $500 from meta (all measured phantoms <$400; the $500-2k
band held real thin crosses — BANL/ALP). (2) **SKYQ stale-cross-as-fresh** —
MINI silent 2.5h while consolidated traded; frozen EMAs "crossed" on the
resume tick → `stale_gap_bars` guard (intrabar suppressed after >3 intervals
in-session silence; session-open exempt). (3) **thin-tape ⚠️** on rows with
sibling notional <$5k at cross ("verify on chart"). (4) **in-ladder 5m
display skip REMOVED** (LABT: Telegram fired, row hidden in a section the
operator hides — alert and row must match). (5) **TV-log audit**: 11 TV 1h
alerts vs our 1 — all misses = sparse/stale MINI 1h series → HTF backfill
gains Yahoo consolidated fallback + staleness targeting (newest bar >12h) +
hourly rescan w/ 2h per-symbol retry; verified live (TMDE 98 stale bars →
948 fresh). (6) **FAC anatomy** — 11-min lag fully explained by a 25-min
MINI print gap; led to the feed decision: **operator chose to STAY on
EQUS.MINI** (SIP/PLUS upgrade path documented in tick_feed_scoping memory).
(6b) **LICN 5m warmup fix** (same day, morning): 16 MINI bars in 3d while
Yahoo had 167 — the 5m Yahoo fallback now triggers on SPARSE (not just
empty) MINI series; bars_5m seed window 48h→5d, retention 3d→6d,
direct-seed slice 120→200 bars. (6c) freshly confirmed rows pulse green
(tf-scaled: 5m 5min / 1h 15min / 4h 30min).
(7) **ZBAO pending-cross mechanism** — a price-coherent cross on a junk bar
(the quiet curl, the operator's core thesis) is PENDED, not consumed;
converts to nomination/confirm when dollars arrive while fast>slow, anchored
at the ORIGINAL cross (`cross_ts_sec`, meta `pending_min`); outlier junk
(LBTYK class, `junk_outlier_pct` 5%) still discarded. (8) **Calculation
audit**: S14 golden EMA (1e-9), S19 seed/live bit-identity, backfill-1h ==
live-5m closes join (8/8 exact), `/ema-debug` endpoint; suite = 21
scenarios. Alert surface (phone+sounds+title) is EMA-only per XALRT + web
kill-switch maps in useScreenerAlerts/useTabTitleFlash (observe=soft E5,
confirm=B5→F#6 pair). ⚠️ Grading: cross semantics changed repeatedly TODAY
(floors 11:05, floor $500 + guards ~13:50-15:20, pending-cross ~16:30 UTC) —
the clean 10/65 segment effectively starts 2026-07-23.

XALRT. **📈 cross-confirm Telegram + everything else muted (2026-07-22,
operator's call).** New `ema_cross` alert component: 📈✅ push on every
volume-confirmed cross (any timeframe; once per ticker+tf/ET-day, dedup
reseeded from tier_events on boot so deploys don't re-ping; message carries
tf, expansion multiple, cross price + extension, intrabar flag, and the
day's catalyst when the news enrichment has landed). Simultaneously the
droplet's `.env` sets `ALERTS_DISABLED` to ALL other components (momentum,
ignition, new_ignition, fresh_burst, accum, tick_watch, tick_catch, radar,
dual_signal, swing) — detection/grading/dashboard unaffected, re-enable by
editing the env + `up -d api`. The phone now speaks only when a cross
confirms. ⚠️ The muted components' alert *quality* can no longer be judged
from Telegram history — tier_events remains the only grading source.

XNEWS. **📈 cross rows get news support (2026-07-22).** Cross tickers are
mostly off-screen, so the per-cycle news fan-out never covered them; rows
now enrich async — DB-first (Benzinga market-wide sweep/radar articles),
`fetchAndStoreTickerNews` top-up as fallback, shared URL classification
cache, cached per ticker/news-day, applied across all of a ticker's
timeframe rows. UI: 🔥 CatalystBadge on the row → news modal. Same day:
EMAs 6/50→10/65 all layers + 5m cooldown 60→30min (see grading caveat in
the pending task). Grading cut now available: crosses with vs without
same-day catalyst (SQL join tier_events↔news_articles).

ALRT. **Per-component Telegram kill switches + 📰 radar toggle (2026-07-21,
follow-up to EMAX).** Operator asked whether hidden components should stop
being computed server-side; answer on the record: NO — layers feed each
other (radar arms the detector, accum promotes through 👀, EMA grading
reads ladder state) and an uncomputed layer is an ungraded layer. The
architecture is: compute always → grade always → alert selectively →
display selectively. Shipped the two missing dials: (a) `ALERTS_DISABLED`
env var (comma-separated slugs: momentum, ignition, new_ignition,
fresh_burst, accum, tick_watch, tick_catch, radar, dual_signal, swing) —
checked at all 12 sendTelegram sites in the poller; dedup sets still mark
suppressed alerts so re-enabling mid-day doesn't replay the backlog;
muted set logged on first alert. (b) NEWS RADAR joined the hideable
sidebar sections (📰 toggle, `hide_news_radar`). `/alerts off` remains the
global mute; `TICKFEED_ENABLED` remains the whole-feed circuit breaker.

EMAX. **📈 EMA-cross layer promoted to first-class citizen (2026-07-21, the
operator's favorite component).** Four asks, all shipped: (1) **intervals
are configurable** — tracker refactored around an `htfLayers` list in
tickfeed (`makeHtfLayer(cfg, table, {spanDays, retentionDays, deepDays,
offset})`); **1h added** (`EMA_CROSS_1H`, migration `20260721130000_bars_1h`,
30d Databento backfill / 35d retention, 2-bar cooldown); adding/removing an
interval = one entry + one migration. (2) **UI groups crosses per
timeframe** — 📈 EMA 5M / 1H / 4H sections, payload capped per tf (10/8/8),
HTF display windows 3h/6h. (3) **LIVE TICKS + ignition NEW/TOP list are
hideable** — new header toggles (🛰️/⚡, strikethrough when off), persisted
per-user in `user_panel_layout` (`hide_live_ticks`/`hide_ignition_list`);
DISPLAY-ONLY: poller/alerts/tier_events untouched, re-enable is instant;
hiding the ignition list uncaps the EMA sections' heights. (4)
**calculation review** — golden-reference test (S14: tracker EMAs equal an
independent implementation to 1e-9 over a 400-bar random walk) + new
`GET /api/screener/ema-debug?ticker=X` returning each layer's live
EMA6/EMA50/bars/sibling-median (+ observation state) for TV-chart
comparison; verify script now 15 scenarios. Audit found no defects in the
closed-bar/intrabar math beyond the already-fixed WOK classes; known
remaining approximations documented in detection-layers.md (session-blind
sibling window at the open, bars-not-minutes observation).

X4H. **📈 4h EMA-cross layer — the operator's swing-timing tool (2026-07-17).**
Operator showed 4 charts (KYTX/SHPH/CODX/CNTX) of 4h 6/50 crosses preceding
swings and proposed: enter on the 4h cross with a tight stop, exit
discretionary. Clarified scope: THEY keep the entry filter and the exit;
what they need is detection the second the cross happens (not at 4h bar
close). Cross-as-signal remains twice-measured-at-chance — the edge claim
lives in their manual filter, so the layer is graded on lead time + fire
rate, not precision. **Built:** `EmaCrossTracker` parameterized
(`EmaCrossConfig`; events carry `tf`), second instance at `EMA_CROSS_4H`
(interval 14400, buckets anchored to the ET session grid 04:00/08:00/… —
TV's ETH 4h bars; EDT/EST offset recomputed at midnight); intrabar detection
gives second-level cross latency. Warmup (~50 4h bars ≈ 2-3 weeks) is
impossible live → new `bars_4h` table (migration `20260717120000`, 40d
retention) + Databento ohlcv-1h backfill (35d, batched ~100/req via the
generalized `fetchDatabentoAgg`, no Yahoo fallback — MINI-invisible names
have no baseline anyway). **Surfacing: dashboard-only by operator choice**
(4H badge in the EMA CROSS section, rows linger 6h, in-ladder names NOT
skipped — unlike 5m; no Telegram/ping until `tier_events meta.tf='4h'` shows
the real fire rate; expect dozens-to-~100+/day across ~1,500 known runners).
Verify script → 12 scenarios (S12: 4h config, offset grid, tf stamping).
**Day-1 fixes (the WOK phantom cross — THREE stacked root causes, all
found from the operator's first check and fixed same day):**
(1) **Databento end-bound**: the first 120d pass 422'd every chunk —
`get_dataset_range`'s top-level end is the max across schemas and reads
rounded forward, while ohlcv-1h only rolls once an hour; clamp is now to
the PER-SCHEMA end (`databentoSchemaEnd`), plus per-chunk retry instead of
aborting the fleet. (2) **Depth**: 35d backfill ≈ 1× the 4h-EMA50 span →
no convergence; now 120d (~150+ bars), retention/boot-seed 130d, skip rule
= ≥150 banked bars OR history reaching ≥100d back. (3) **Splits** (the one
that actually bit WOK): TV charts are split-ADJUSTED, Databento is raw —
WOK reverse-split ~1:78 Jun 18, so even 212 raw bars gave EMA50 2.00 vs
TV 2.63 and a $2.04 poke "crossed". `adjustSplitHistory` (pure, tested,
applied read-side at seed time; DB keeps raw): overnight UP-jumps ≥4.85×
= split, 1.94–4.85× only within 2.5% of a whole number; DOWN-moves never
(WOK's own -89% overnight crash is real history). Verified on WOK's real
series: adjusted EMA50 2.742 ≈ TV's 2.63, cross condition flips false.
**Grading note: 4h tier_events before ~2026-07-17 14:50 UTC are blind
(scale-broken EMAs) — the 4h trial effectively starts from then.**
**Watch:** (a) fire rate + time-of-day clustering after a few days → pick
Telegram gate (operator deferred: watchlist/screens were the candidates);
(b) confirm semantics on 4h are untuned first-guesses (sibling 12×4h bars,
$10k floor) — nomination is the product, confirms are telemetry;
~~nominations deliberately have NO notional floor~~ **superseded
2026-07-22 (the LBTYK phantom):** a single 1-share odd-lot print at $10.99
vs a $9.97 market ($11 notional!) provisionally "crossed" and nominated —
a print the SIP tape excludes, so TV never saw it. Nominations now need
`nominate_min_notional` $2k of bucket/bar dollars (junk-print guard, all
timeframes; no state consumed on intrabar rejection — real bursts fire
seconds later once dollars accumulate); (c) first boot
pays the full ~15-request Databento pass, subsequent boots seed from
bars_4h.

XINTRA. **📈 intrabar detection — TV-parity, closes the ~5-min lag (2026-07-16,
the DXST/EHGO report).** Operator's TV alerts fired 42–75s INTO the 5m bar
(13:00:42 EHGO, 13:01:15 DXST local); our closed-bar-only evaluation waited
for the bar close (+ next-trade close semantics) → ~4–5 min behind, exactly
as reported. Now every live tick also runs a provisional check: EMAs folded
forward with the current price (closed-bar state never mutated — at a
bucket's final tick the provisional diff equals the closed diff, so the
closed-bar path remains a pure backstop), and confirms may fire MID-BAR on
the bucket's accumulated volume — sound because volume is monotone (anything
clearing a threshold mid-bar clears it at close). The mid-bar cross bar keeps
the 5× instant rule; later bars the 3× rule; notional/price floors unchanged.
Price-side repaint (a poke that un-crosses by close) can nominate a wiggle —
same as the operator's TV alert — and the volume stage disposes of it; watch
the wiggle-nomination rate in grading via `meta.intrabar`. Kill switch:
`EMA_CROSS.intrabar_detect`. Verify script extended to 11 scenarios (S9–S11:
mid-bar nominate→confirm, cross-bar 5×-only rule, floors + cooldown under
intrabar).

XMETA. **📈 layer pre-grading hardening (2026-07-16, two sessions).** Overnight
session: (1) **Databento historical is now the primary EMA backfill** (batched
~100 syms/request, ohlcv-1m→5m locally, same MINI scale as live — kills the
Yahoo volume-scale skew for the primary path; Yahoo stays as per-symbol
fallback for MINI-invisible names; end clamped to `available_end`, the 422
fix); (2) **expired nominations re-arm after a 60-min cooldown** — the
once/ticker/day lock was measured wrong on TGHL (a weak 0.4× cross burned the
slot; the real 6.7× cross ran +20%); a confirm still ends the symbol's day.
Day session: (3) **confirm notional floor** `confirm_min_notional: $10k`
(feed-visible, first guess) on BOTH confirm paths — the sibling floor is 50
*shares*, so a dead-tape "3×" could confirm on ~$200; an instant-confirm
failing it demotes to a nomination; (4) **gradable meta** — tier_events cross
rows now carry `vol`/`sib_median`/`notional` (expire carries `sib_median` so
`peak_ratio` converts to absolute) — bars_5m prunes at 3d, so without this the
grading week couldn't audit confirm quality retroactively; (5) committed
synthetic regression `apps/api/scripts/verify-ema-cross.ts` (8 scenarios:
warmup, both confirm paths, floors, price hold, cooldown, seed silence — the
overnight session's tests had lived in scratch). **Grading note: cross-funnel
semantics changed 2026-07-16 — segment at the date, count per observation.**

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

COVER. **Tick coverage + EMA warmup fully closed (2026-07-15, the TGHL case).** TGHL (prior close $0.66) ignited premarket; ignition screen caught it at +28.5% but the per-second tiers first saw it at +91% — it sat below the momentum filter's $1 floor and the tick universe derived ONLY from the momentum filter. Three fixes same day: (1) **universe union** — tick subscriptions now cover momentum's structural band ∪ the ignition band (`sh_price_u10`), ~3,450+ symbols, two Finviz exports 1.3s apart; (2) **bars_5m persistence + boot replay** — live closed 5m bars persist (3d retention), boots replay 48h, so the 📈 layer's 50-bar warmup survives deploys (three 07-14 deploys had left it silent all of 07-15); (3) **Yahoo 5m backfill** — known runners below ~50 banked bars fetch free Yahoo history (1/2s, once/symbol/day, rescan 4h; direct-seeds only never-streamed symbols; consolidated-vs-MINI volume-scale caveat documented, self-heals in ~1h). Also corrected on the record: TGHL-class moves with a preparatory 5m bar ARE EMA-catchable (~+28%, on par with ignition) — the earlier "not catchable" claim was wrong; only pure gaps cross one bar late. **The 📈 trial runs with full infrastructure from 07-16.** Full layer reference: `docs/detection-layers.md`.

NEWSDAY. **🔥 icons no longer vanish at midnight ET (2026-07-10, the VRAX report).** Operator: "tickers don't show the fire icon even when there's news." Data showed the real bug: at 00:00 ET the poller cleared its news caches and "today's news" became the new (empty) calendar day — ignition rows went 174/174-with-catalyst at 23h ET → 0/174 at 00h, while the board still shows the finished day's change% until premarket. For a UTC+5 operator, 00:00–04:00 ET is prime review time. **Fix:** the NEWS day rolls at **04:00 ET** (premarket start) — Finviz/Yahoo/Benzinga/halt today-filters + headline/classification caches follow `newsDayEt`; alert dedups, watermarks, and per-day trading state stay midnight-anchored. Related display nuance recorded: a row's flame reflects the source-precedence headline (halt > sec > bz > yahoo > finviz), so a 46-score LULD halt can front a better PR — the modal has the full list. Also that day: Benzinga multi-ticker "why is it moving" blurbs carry ONE representative ticker's quote-page URL — single-ticker news lists now rewrite `/quote/<sym>` links to the viewed ticker (the SOC→SKYQ case).

XCROSS. **📈 EMA-cross layer — the operator's manual TV loop, automated (2026-07-10).** Operator (5th EMA raise, now with the right architecture): EMA(6/50) bullish cross on **5m bars** over the known-runner set NOMINATES a ticker for a ~30-min observation; it CONFIRMS only if a closed bar's volume runs ≥3× the sibling median (prior hour's bars) with price ≥ cross×1.005 — or instantly if the cross bar itself arrives ≥5×; no expansion → silent expire. This matches the twice-measured verdict: the cross has no selection power (it's the *nominator*), volume-expansion is the carrier (the *confirmer*). Built on tick-feed per-second bars aggregated in-process (`services/ema-cross.ts`, `EMA_CROSS` knobs) — zero API calls. Sidebar section 📈 EMA CROSS (dim "…observing" → green "✅ N× vol"), soft ping + browser notif on CONFIRM only, no Telegram until graded. `tier_events` tier='cross' (nominate/confirm/expire, with `in_ladder` when LIVE TICKS already had the name — those skip display). **Caveats:** (a) ~~EMAs need 50 closed bars after each deploy~~ **FIXED 2026-07-15**: closed bars persist to `bars_5m` and boot replays 48h — warmup survives deploys (see the deferred-list entry). (b) Sparse tapes close bars late (bar closes on the next trade — TV-like). (c) Fire rate unknown — grade nominate→confirm/expire rates + confirmed forward outcomes from tier_events after ~a week; knobs: `confirm_vol_x`, `sibling_min_sh`, `observe_bars`, `warmup_bars`. **Follow-up fix (2026-07-15, the OPTX confusion):** row timestamps now use the BAR's close time (TV labels bars by OPEN — a 5m skew read as a missed detection) and the row's "ago" always anchors on the cross ("cross 20m ago"). Day-1 funnel: 37 nominations → 13 confirms (35%) / 14 expires.

ACCUM2. **Detector-side 🤫 — the sub-screen accumulation tier (2026-07-08, the SLS case).** Operator raised EMA/MACD a fourth time with a real win: their 1h TV cross alerted SLS at 09:25 ET (+3%), our first signal was the 👀 at 09:41 (+10.2%). Diagnosis: SLS **never hit any screen** (day-RVol never cleared momentum's 5× Finviz gate; $14 ≫ ignition's sub-$1), so the screen-scanning accum tier was blind and the tick feed's first word is the +10% watch — a structural sub-10% blind zone for unscreened names. **Built the queued phase 2:** the tick DETECTOR now emits an `accum` event when cum ∈ [3%, 10%) AND trailing volume ≥3× its own quiet baseline, SUSTAINED 120s (the measured persistence lesson), with the junk floor + near-high checks (`TICK_DETECT.accum_*`). Rides the existing ladder (teal 🤫 row, promotes at the +10% cross, confirm/TTL/tier_events with `meta.source='tick'` vs `'screen'`); dashboard-only — no Telegram until tier_events grades this source. Also fixed a latent baseline bug found on the way: surge windows below mom_min used to feed the "quiet" baseline and self-dampen (an accumulation burst at +4% polluted its own reference); quiet sampling now excludes ≥3× windows. Regression: identical watch/confirm timings, false-confirms 1/38 unchanged, 0 accums on the fizzler control, gappers correctly produce no accum (hold unmeetable at their speed). **Watch:** detector-accum volume/day unknown — grade `tier_events WHERE tier='accum' AND meta->>'source'='tick'` after a few days; dial `accum_relvol_min` 3→5 if noisy.

SEEDT. **seedTierState() — the live tier state now survives deploys too (2026-07-15).** tier_events made the *record* durable; this closes the *working memory* half: on boot the poller replays today's tier_events in order, rebuilding the LIVE TICKS ladder (accum/watch/confirmed inside TTLs), NEWS RADAR entries, confirmed EMA crosses, AND all once-per-day dedup sets (accumSeen, alertedTickWatch/Catch, alertedAccum via bullish_news, alertedNewsRadar + radarSeenUrls) — so a mid-session deploy no longer blanks the sidebar or re-pings names (the AUID residual, closed). Deliberate limits: reseeded 'observing' cross rows are DROPPED (their tracker-side observation died with the old process — only confirmed crosses persist); detector internals (quiet baselines) and EMA warmup (~4h of 5m bars) still rebuild live — bar persistence is the remaining piece, only worth it if the cross layer graduates. Radar hit meta now records `urgency` for faithful reseeds.

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

## Other deferred / known (refreshed 2026-08-04)

- **The grading pass** — the single next task; see THE PENDING TASK above
  (reclaim precision per tf, clean segment from 2026-07-28). Watch reclaim
  volume/day post-07-27 (junk-arming pends + no-stale-wait add fires on
  sparse names — dials: `SPARSE_5M_MIN_BARS_24H`, the coherence gate,
  `nominate_min_notional`).
- **Databento data-quality findings worth a support ticket:** (a) weekend
  test-session prints stream on live EQUS.MINI and appear in historical
  ohlcv (we filter both ends now); (b) PFSA ohlcv-1h interleaves two price
  scales ~25× apart for months (premarket/AH vs regular buckets); (c)
  single wildly off-scale poison prints (EDBL). All contained by our
  guards + Yahoo fallbacks, but the vendor should know.
- **⚠️ Droplet RESIZED 2 GB → 4 GB (2026-07-28, operator's call) after the
  swap-thrashing incident below; ~2 GB headroom at current load, sweep peaks
  ~1.3 GB RSS. The incident record (measured on the 2 GB box):** Symptom that led here: "dashboard stays empty for a
  while after reload". Measured mid-incident: Node **RSS 877 MB + 1.53 GB
  SWAPPED**, host 102 MB free, **80–90% iowait** during background sweeps —
  the request path itself was fine between bursts (p50 0.36s), so this
  presents as INTERMITTENT slowness, not steady slowness. Root cause was the
  1d refetch storm (fixed — see below); after the fix + restart: RSS 294 MB,
  swap 0, 1.1 GB available. **Watch RSS over days** — before the fix the
  process climbed to 2.4 GB in 10 hours. Boot alone replays ~1.6M persisted
  bars through the trackers (peak 436k rows in ONE array in
  `seedTrackerFromTable`), and there are 5 EMA layers + a 3.4k-symbol tick
  feed. If it creeps back into swap the levers are, in order: trim bar
  retention (bars_1d 260d / bars_4h 130d are the big ones), chunk the boot
  seed per symbol instead of one array per table, or resize 2→4 GB
  (~$12→$24/mo). Diagnose with `free -m`, `VmRSS`/`VmSwap` in
  `/proc/<node-pid>/status`, and `vmstat 1 3` (watch `si`/`wa`).
- **HTF freshness must scale with the bar interval (fixed 2026-07-28):** the
  backfill's "stale" test was a flat 12h for every layer, but a 1d bucket
  closes once per ET day and never across a weekend — so **all 1,507 daily
  series read stale permanently (min age 71h)** and every sweep refetched
  each one's 240d of ohlcv-1h (~40 min, ~350k upserts, metered Databento).
  Passes ran 60–100 min against an hourly timer = continuous load. Now
  `max(12h, 4 × interval)` (1d 96h, 4h 16h, 15m/1h unchanged): 1d stale
  1507 → 18. **If another coarse layer is ever added, check this rule
  first** — the same trap is waiting for it.
- **CI deploy flakiness (watch):** two incident classes on 07-25/27 — a
  Buildx-setup infra flake failing the whole run (rerun fixes), and
  deploys that succeed WITHOUT recreating the api container (image digest
  unchanged or compose no-op). After any deploy that matters, verify by
  grepping a code marker in the container's dist/, not by run status.
- **Dead-tape nominations stay (operator's call, 2026-07-24, the PBM case):**
  odd-lot-only trickles on consolidated-sparse names can nominate (cross +
  reclaim) with ⚠️ and can never confirm ($10k floor unreachable) — the
  operator reviewed the PBM anatomy (TV's tape silent 2h, our feed saw $1.1k
  of odd lots) and chose to keep the current floors. No `sib_median × price`
  nomination floor for now — if grading shows the dead-baseline band
  (sib_median×cross_price < ~$2k) is pure expire-noise, the calibrated
  conditional floor (dead baseline ⇒ escalated trigger notional) is the
  designed dial; meta carries everything needed to place the line.
- **TV links are exchange-qualified for Nasdaq names (2026-07-25, the SPRO
  collision):** TV resolved bare "SPRO" to CBOE's S&P 500 Buffer Protect
  INDEX instead of Spero Therapeutics — the operator's chart-verification
  loop landed on the wrong instrument. All TV chart links (11 Telegram
  formatter sites + 3 web sites via `tvChartUrl`) now prefix `NASDAQ:` for
  SEC-confirmed Nasdaq listings (`company_tickers_exchange.json`, daily,
  `tvSymbol()` in edgar.ts; web fetches `/api/screener/tv-map` lazily).
  NYSE deliberately stays bare — SEC lumps NYSE American/Arca under "NYSE"
  while TV files those under AMEX: (CPHI), so a blind prefix would break
  Arca links.
- **Weekend bars are exchange TEST prints — dropped at the gate
  (2026-07-25, a Saturday):** Databento streamed 132k live bars on a closed
  Saturday (exchanges run scheduled production tests; the prop feeds behind
  EQUS.MINI carry the test prints at plausible-but-fake prices). ROLR
  "printed" +9% and fired a phantom 4h reclaim; pendings and near-misses
  fired too, and test bars were being PERSISTED into bars_5m/1h/4h (would
  have poisoned Monday's seed replays). onBar now drops any bar whose ET
  day is Sat/Sun before every consumer; Saturday's leaked bars + the two
  phantom tier_events (VLN 5m, ROLR 4h reclaims) purged from prod.
- **Benzinga + Anthropic PARKED (2026-07-25, operator's call):** EMA
  layers are the primary instrument, so both tokens are COMMENTED OUT in
  the droplet .env — key presence IS the toggle (operator preferred one
  mechanism over separate _DISABLED flags; $147/mo Benzinga, Anthropic was
  already dead on exhausted credits).
  While parked: 📰 radar is fully DARK (the Benzinga delta is its only
  source — no radar rows, no radar grading, no radar tick-arming); news
  coverage = Finviz + Yahoo + SEC + halts (cross-row enrichment unaffected
  — its top-up is Finviz/Yahoo); classification stays rules-only. This
  consciously suspends the "compute always" principle for the radar layer
  to save the subscription. Re-enable: uncomment the token + `up -d api`.
- **Yahoo's unofficial API is now load-bearing** for thin-tape EMA warmups
  (5m sparse fallback + HTF consolidated fallback, hourly scans; since
  07-23 also the warm-but-sparse 5m/HTF re-seeds — the daily sparse sweep
  is ~hundreds of calls at 1.5s spacing, watch for throttling). If Yahoo
  breaks: MINI-quiet names lose warmup/freshness/level-correction
  (LICN/TMDE/CPHI classes return — though gap-decay alone now keeps sparse
  EMA horizons TV-like); everything else unaffected. Watch `viaYahoo` +
  `sparse done` counts in `[ema-backfill]` logs. The clean escape remains
  the Databento SIP/PLUS upgrade (or metered EQUS.PLUS historical polling).
- **Deploy-loss residuals (tracker memory):** 5m 'observing' rows drop on
  reseed (HTF rows survive their display windows); PENDING reclaims (thin
  window / junk-arming / decay-flip) are lost on deploy — re-fire needs the
  geometry to recur; detector quiet baselines rebuild ~1-2 min. All logged
  classes, all self-correcting.
- **Trade Journal attribution join (TJ)** — trades ↔ `screener_outcomes` +
  detections on `(ticker, et_date)`; the report-system payoff, untouched since
  06-21.
- ✅ **EMA warmup persistence — DONE 2026-07-15** (`bars_5m` table + boot
  replay): three 07-14 deploys had left the 📈 layer completely silent on
  07-15 (warmup restarted each time; thin names need ~a day of closed bars),
  which made the trial ungradable — so it got promoted from "if it graduates"
  to prerequisite. Live closed 5m bars persist (batched, 3-day retention,
  pruned at midnight); boot replays 48h through the tracker silently (no
  events from history; overlap-guarded). First boot after this deploy seeds
  from an empty table — persistence accumulates from then on, so the layer is
  warm across all subsequent deploys. **Grading note: treat 07-15 as a blind
  day; the 📈 trial effectively restarts 07-16.**
- **DB growth** — 4.9 GB total, ~20 GB/yr run-rate (per-cycle tables dominate);
  95 GB free after the resize (disk grew 67→116 GB) → years of headroom.
  Plan when disk crosses ~60%: archive+prune
  per-cycle rows >120–180d (or month-partitioning). Deliberately deferred.
- **Databento capacity** — flat $199/mo live (EQUS.MINI, ~3.4k symbols);
  historical is metered but tiny (daily ohlcv backfills bill cents; the
  hourly HTF scans are batched 100 syms/request). Real limit = ONE live
  connection (deploy-overlap incident class, fixed 06-22). Bar stores:
  bars_5m (**45d retention** since 07-30 — grading evidence, with OHLC;
  5d boot-seed window unchanged), bars_15m (12d), bars_1h (35d), bars_4h
  (130d), bars_1d (260d).
- **Known-runner set eviction** — `radarHistory` re-seeds per boot (rolling
  30d); a process running many weeks without deploys wouldn't evict. Moot at
  current deploy cadence; one-line daily reseed if that changes.
- **Tick catches still lack float/catalyst enrichment** (open item d from
  06-23) — note the cross layer got its news enrichment 07-22; the ladder
  did not.
- **Deeper Finviz relief** (share the AH v=152 overlay across screens) and
  **retune swing/dual-signal thresholds from outcomes** — both still open,
  both non-urgent.
- Git state at handover: `main` in sync with origin as of this 2026-07-27
  grooming commit; working tree clean apart from the operator's gitignored
  scratch files.
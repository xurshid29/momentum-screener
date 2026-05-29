// PollerService — the singleton port of screener-poll_breakout.sh.
// One instance per API process. Holds cross-cycle state in memory.
// Single-instance only by design — see CLAUDE.md.

import { getDb } from '../db/index.js';
import type {
  RowStatus,
  ScreenerFilterSnapshot,
  NewsSource,
  CatalystDirection,
  CatalystUrgency,
  Classifier,
  TradingSession,
} from '../db/types.js';
import { fetchScreener, fetchFinvizNews, type ScreenerRow } from './finviz.js';
import { fetchYahooNews } from './yahoo.js';
import { fetchBenzingaDelta } from './benzinga.js';
import { fetchEdgarFilings, type EdgarFiling } from './edgar.js';
import { fetchHalts, type TradeHalt } from './halts.js';
import { broadcast } from './sse.js';
import { sendTelegram, telegramEnabled, escapeHtml } from './telegram.js';
import { scoreRunner, type RunnerScoreBreakdown } from './runner-score.js';
import {
  scoreSwing,
  type SwingScoreBreakdown,
  type SwingSetupFlags,
  type SwingDailyContext,
} from './swing-score.js';
import { shelf, type ShelfInfo } from './shelf.js';
import { dailyBars, getRecentBarsForTickers } from './daily-bars.js';
import { getContinuationCandidates, type ContinuationCandidate } from './continuation.js';
import { classifyByRules, type Classification, type ClassifierInput } from './catalyst-rules.js';
import { classifyByClaude } from './catalyst-claude.js';

const DEFAULTS: ScreenerFilterSnapshot = {
  // Note: no `sh_float_u50` here. Finviz drops rows with null Float when that
  // filter is active, which excludes legitimate nano-cap candidates (e.g.
  // CNSP) where Finviz hasn't computed a Float value. The float ceiling is
  // enforced post-fetch in finviz.ts using shares_outstanding as a fallback.
  filter: 'ind_stocksonly,sh_price_1to25,sh_relvol_o5,ta_change_20to',
  float_max_m: 35,
  top_n: 50,
  accel_threshold: 2.0,
  interval_sec: 20,
};

const DELTA_LOOKBACK_SEC = 1800;

// Ignition screener — a second, volume-led screen run each cycle alongside the
// Momentum one, to catch low-float names in the first minutes of a move.
// See docs/ignition-screener-spec.md.
const IGNITION = {
  filter: 'ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o500',
  // Pre-market liquidity is thin: a nano-float ripping +100% can still be
  // sitting below 500K cumulative shares, so the regular-session filter
  // gates it out until the move is mostly over (see the WHLR post-mortem —
  // it first appeared at +146.65% under the standard filter). The pre-market
  // variant drops the volume floor to 100K while keeping the relvol > 2
  // gate so we don't flood with thin-print noise.
  premarket_filter: 'ind_stocksonly,sh_price_u10,sh_relvol_o2,sh_curvol_o100',
  float_max_m: 15,
  top_n: 80,         // fetched from Finviz, then runner-score-ranked
  min_price: 0.10,   // post-filter — sh_price_u10 has no lower bound
  broadcast_n: 25,   // top-N (by runner-score) kept in the SSE payload + persisted
  alert_score: 58,   // alert threshold — a no-catalyst momentum ignition caps ~60 (float 25 + volume 35)
  // Suppress alerts when first detection is already too extended to trade. The
  // 05-21/05-22 sample showed every "alert fired at +50%+" name (WHLR +146→
  // −119, FRGT +93→−104, ORIS +54→−59, ATPC +89→−14) bled to the close,
  // while the winners (SBFM +3→+47, MRM +6→+18, AKTX +50→+93, CODX +21→+31)
  // all entered below this cap. We still keep the row in the SSE payload —
  // only the Telegram push is gated, so a name that pulls back under the cap
  // and re-fires the score gets a fresh second-leg alert.
  alert_entry_chg_max: 40,
  new_window_ms: 120_000,  // a ticker stays flagged "new" for 2 min after first entering the set
};

// Swing screener — multi-day setups. Runs inside the same 20s poll loop but
// on a much slower cadence (every `cadence_cycles` cycles ≈ 20 min) since
// daily-bar signals don't change intraday. See docs/swing-screener-spec.md.
const SWING = {
  // Universe: $2–$50, avg-vol ≥ 500K (real liquidity), today's RVol ≥ 1.5
  // (real interest today). Float bounds and mcap floor are post-filtered in
  // code since Finviz drops null-field rows when those gates are in-filter.
  filter: 'ind_stocksonly,sh_price_o2,sh_price_u50,sh_avgvol_o500,sh_relvol_o1.5',
  float_min_m: 5,
  float_max_m: 100,
  mcap_min_m: 50,
  top_n: 100,
  broadcast_n: 25,
  cadence_cycles: 60,                  // ~20 min at the 20s interval
  alert_score: 65,
  // Force a refresh once per ET day at/after 16:30 ET — that's when today's
  // close has landed in Finviz quote_export, so the daily-bars service can
  // populate today's complete bar and we can score `close_in_top_q`.
  post_close_minute_et: 16 * 60 + 30,
};

// Continuation list — every Nth cycle re-runs the SQL aggregation. 30 cycles
// at the 20 s base interval ≈ 10 min, well inside the "days seen" signal's
// natural change rate. See services/continuation.ts for the query cost.
const CONTINUATION_REFRESH_CYCLES = 30;

// Dual-signal alert — fires when a ticker on the Continuation list (≥ 2 days
// of Ignition history) also has a meaningful Ignition score *this* cycle.
// That's the CODX-day-2/3 trigger: not the first day's spike (caught by the
// vanilla Ignition alert), but the *confirmation* that the multi-day move is
// real. Score floor is lower than Ignition's 58 because the multi-day prior
// already de-risks the signal. Bullish-only — a continuation candidate that
// also has bearish news landing today is a fade in progress, not a runner.
const DUAL_SIGNAL = {
  min_ignition_score: 40,
};

export interface CyclePayload {
  cycle_id: string;
  polled_at: string;
  session: TradingSession;
  config: ScreenerFilterSnapshot;
  rows: EnrichedRow[];
  banners: {
    new_with_catalyst: string[];
    fresh_news: string[];
  };
  fresh_news: NewsHeadline[];
  ignition: IgnitionRow[];
  swing: SwingRow[];
  continuation: ContinuationCandidate[];
}

export interface EnrichedRow extends ScreenerRow {
  status: RowStatus;
  prev_change_pct: number | null;
  accel_delta: number | null;
  vol_5min: number | null;          // 5-min-equivalent traded volume (extrapolated during a ticker's first ~5 min)
  rel_vol_5min: number | null;      // (vol_5min / (avg_volume / 78)) * 100
  // Anchored VWAP since the ticker first appeared *today*. Computed in-memory
  // from cycle-to-cycle volume deltas × the per-cycle price. Persists across
  // PM → regular → AH within a single ET day so a pre-market spike's volume
  // keeps weighting the indicator into the regular session — matches a chart
  // "Session/Day" VWAP. Null on the first cycle (no delta yet) and whenever
  // price or volume is missing.
  vwap: number | null;
  above_vwap: boolean | null;
  is_fresh_news: boolean;
  has_today_news: boolean;
  news_title: string | null;
  news_source: NewsSource | null;
  news_url: string | null;
  finviz_url: string;
  catalyst: CatalystInfo | null;
  // Effective-shelf / dilution status from a 12-month SEC submissions lookback.
  // The runner's kill-switch — see services/shelf.ts.
  shelf: ShelfInfo | null;
}

// A Momentum-style enriched row plus its Ignition-screener runner-score.
export interface IgnitionRow extends EnrichedRow {
  runner_score: number;
  score_breakdown: RunnerScoreBreakdown;
  // True for the first ~2 minutes a ticker is in the Ignition set — drives the
  // sidebar's pinned "New" section so a fresh low-score name isn't buried.
  is_new: boolean;
}

// A Momentum-style enriched row plus its Swing-screener score and the
// daily-bar context snapshot the score was computed from.
export interface SwingRow extends EnrichedRow {
  swing_score: number;
  score_breakdown: SwingScoreBreakdown;
  setup_flags: SwingSetupFlags;
  daily_context: SwingDailyContext;
}

export interface CatalystInfo {
  score: number;
  urgency: CatalystUrgency;
  direction: CatalystDirection;
  type: string;
  reason: string;
  risk_flags: string[];
  classifier: Classifier;
}

export interface NewsHeadline {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
  secForm?: string;     // SEC form type — set only when source === 'sec'
  haltReason?: string;  // Nasdaq halt reason code — set only when source === 'halt'
}

class PollerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private firstPoll = true;
  private config: ScreenerFilterSnapshot = { ...DEFAULTS };

  // Cross-cycle state (the equivalents of PREV_FILE / BZ_HEADLINE_CACHE / BZ_TS_FILE).
  private prevChange = new Map<string, number>();      // ticker -> last seen change%
  // Per-ticker rolling volume samples (timestamp seconds, cumulative day volume).
  // Used to compute the last-5-minutes volume diff. Trimmed to ~10 minutes deep.
  private volHistory = new Map<string, Array<{ ts: number; volume: number }>>();
  // Per-ticker anchored VWAP tallies. cumPxVol and cumVol accumulate
  // (Δvolume × price) across cycles since first detection *today*; lastVolume
  // is the previous cycle's cumulative day volume, used to derive the delta.
  // Persists across PM → regular → AH so a pre-market spike's volume keeps
  // weighting the VWAP into regular hours (matches a chart's day-session VWAP).
  // Reset at midnight ET only.
  private vwapState = new Map<string, { cumPxVol: number; cumVol: number; lastVolume: number }>();
  private bzHeadlineCache = new Map<string, NewsHeadline>(); // ticker -> latest headline (any source merged)
  private bzWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  // SEC EDGAR + Nasdaq halts are delta feeds too — a watermark per source
  // tells us which filings/halts are new this cycle (i.e. audio-worthy).
  private secWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  private haltWatermark = Math.floor(Date.now() / 1000) - DELTA_LOOKBACK_SEC;
  private lastEtDate = '';
  private lastSession: TradingSession | null = null;
  // Per-article-URL classification cache. Lets the LLM classifier
  // overwrite the rule-based score in-place; the next cycle's payload
  // automatically picks up the refined verdict without a DB read.
  // `needsLLM` is set when the rule-based result is written and
  // cleared once OpenAI has refined (or once we've tried and failed).
  private classificationCache = new Map<string, {
    classification: Classification;
    classifier: Classifier;
    articleId?: string;
    needsLLM: boolean;
    input: ClassifierInput;
  }>();
  private llmInFlight = false;
  // Article URLs already pushed to Telegram — alert once per article.
  // Cleared at midnight ET.
  private alertedUrls = new Set<string>();
  // Tickers already Telegram-alerted from the Ignition screener today.
  private alertedIgnition = new Set<string>();
  // First-seen time (epoch ms) per ticker currently in the Ignition set —
  // drives the sidebar's "New" section. Self-maintaining: only currently
  // present tickers are kept, so a ticker that leaves and returns re-counts
  // as new, and no daily/session clear is needed.
  private ignitionFirstSeen = new Map<string, number>();
  // Swing screener cadence — fetch + score every SWING.cadence_cycles cycles
  // (~20 min) plus a forced 16:30 ET post-close refresh. Between scans we
  // re-broadcast lastSwingRows unchanged.
  private swingCounter = 0;
  private lastSwingRows: SwingRow[] = [];
  private lastSwingComputedAt = 0;
  private lastForcedSwingPostCloseDate = '';
  // Tickers already Telegram-alerted from the Swing screener today.
  private alertedSwing = new Set<string>();
  // Tickers already Telegram-alerted from the Continuation dual-signal today.
  private alertedDualSignal = new Set<string>();
  // Continuation list cache. The SQL aggregation over 5 days of ignition_results
  // costs ~1.5 s on the prod-sized dataset — too much for every 20 s cycle.
  // Refresh every CONTINUATION_REFRESH_CYCLES cycles (~10 min) and re-broadcast
  // the cached value in between. The signal updates on the scale of days, so
  // the cache freshness is more than enough.
  private continuationCounter = 0;
  private lastContinuation: ContinuationCandidate[] = [];
  private lastContinuationComputedAt = 0;
  // Runtime mute for Telegram alerts — toggled by the bot's /alerts command.
  // Resets to false on restart by design (no persistence — the dashboard +
  // sidebar still surface everything, this only quiets the push channel).
  private alertsMuted = false;

  // Last full payload, served by /api/screener/latest for new clients.
  private lastPayload: CyclePayload | null = null;

  status() {
    return {
      running: this.running,
      first_poll: this.firstPoll,
      session: this.lastSession,
      tracked_tickers: this.prevChange.size,
      cached_headlines: this.bzHeadlineCache.size,
      bz_watermark: this.bzWatermark,
      sec_watermark: this.secWatermark,
      halt_watermark: this.haltWatermark,
      swing: {
        cycle_counter: this.swingCounter,
        cached_rows: this.lastSwingRows.length,
        last_computed_at: this.lastSwingComputedAt
          ? new Date(this.lastSwingComputedAt).toISOString()
          : null,
        last_post_close_refresh: this.lastForcedSwingPostCloseDate || null,
      },
      continuation: {
        cycle_counter: this.continuationCounter,
        cached_rows: this.lastContinuation.length,
        last_computed_at: this.lastContinuationComputedAt
          ? new Date(this.lastContinuationComputedAt).toISOString()
          : null,
      },
      telegram_enabled: telegramEnabled(),
      config: this.config,
    };
  }

  setConfig(partial: Partial<ScreenerFilterSnapshot>) {
    this.config = { ...this.config, ...partial };
    void this.persistConfig();
  }

  getConfig(): ScreenerFilterSnapshot {
    return { ...this.config };
  }

  // Restore the persisted config (screener_settings holds a single row).
  // Falls back to the code DEFAULTS when nothing has been saved yet.
  private async loadConfig() {
    try {
      const row = await getDb()
        .selectFrom('screener_settings')
        .select('config')
        .where('id', '=', 1)
        .executeTakeFirst();
      if (row?.config) {
        this.config = { ...DEFAULTS, ...row.config };
        console.log(`[poller] restored saved config — filter: ${this.config.filter}`);
      }
    } catch (err) {
      console.error('[poller] could not load saved config, using defaults:', err);
    }
  }

  // Upsert the single global config row so the live filter survives restarts.
  private async persistConfig() {
    try {
      await getDb()
        .insertInto('screener_settings')
        .values({ id: 1, config: JSON.stringify(this.config), updated_at: new Date() })
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            config: JSON.stringify(this.config),
            updated_at: new Date(),
          }),
        )
        .execute();
    } catch (err) {
      console.error('[poller] could not persist config:', err);
    }
  }

  getLastPayload(): CyclePayload | null {
    return this.lastPayload;
  }

  areAlertsMuted(): boolean {
    return this.alertsMuted;
  }

  setAlertsMuted(muted: boolean): void {
    this.alertsMuted = muted;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadConfig();
    console.log(`[poller] starting (every ${this.config.interval_sec}s)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.interval_sec * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  private async tick() {
    if (this.inFlight) return; // skip overlap if previous still running
    this.inFlight = true;
    try {
      await this.runCycle();
    } catch (err) {
      console.error('[poller] cycle error:', err);
    } finally {
      this.inFlight = false;
    }
  }

  private async runCycle() {
    const now = new Date();
    const todayEt = etDateString(now);
    const session = currentEtSession(now);
    if (todayEt !== this.lastEtDate) {
      this.bzHeadlineCache.clear();
      this.classificationCache.clear();
      this.alertedUrls.clear();
      this.alertedIgnition.clear();
      this.alertedSwing.clear();
      this.alertedDualSignal.clear();
      this.lastForcedSwingPostCloseDate = '';
      // Anchored VWAP must reset across days so yesterday's tallies don't
      // contaminate today's. Session-boundary changes inside a day deliberately
      // *don't* clear it (see lastSession block below).
      this.vwapState.clear();
      // Reset the SEC/halt delta watermarks so the new day's first cycle
      // doesn't replay the whole backlog as "fresh".
      this.secWatermark = Math.floor(now.getTime() / 1000);
      this.haltWatermark = Math.floor(now.getTime() / 1000);
      // Mark every cached daily-bar ticker stale so yesterday's just-closed
      // bar gets fetched today. The actual fetches happen on the daily-bars
      // service's own drain loop — this is just an invalidation signal.
      dailyBars.invalidateAll();
      this.lastEtDate = todayEt;
    }
    // A session boundary (notably the 4pm regular→after-hours flip) swaps the
    // change basis entirely. Drop per-ticker movement state so the jump isn't
    // misread as a huge acceleration on the new session's first cycle.
    if (session !== this.lastSession) {
      this.prevChange.clear();
      this.volHistory.clear();
      // vwapState is *not* cleared here. The Finviz `volume` field is cumulative
      // for the whole day, so volume deltas keep accumulating coherently across
      // PM → regular → AH. Keeping the tally lets the anchored VWAP match a
      // chart's "Session" VWAP that includes the extended-hours move (e.g. a
      // pre-market spike still weights the regular-session VWAP). Reset at
      // midnight ET below.
      this.lastSession = session;
    }

    // Swing cadence — fetch + score on the first cycle, every Nth cycle
    // (~20 min), and once after the 16:30 ET close. On non-trigger cycles
    // we re-broadcast the cached lastSwingRows so the SSE payload still
    // carries the most-recent computed swing list.
    this.swingCounter += 1;
    const etMin = etMinuteOfDay(now);
    const isPostCloseTrigger =
      etMin >= SWING.post_close_minute_et &&
      session !== 'closed' &&
      this.lastForcedSwingPostCloseDate !== todayEt;
    const shouldRefreshSwing =
      this.swingCounter === 1 ||
      this.swingCounter % SWING.cadence_cycles === 0 ||
      isPostCloseTrigger;

    // Continuation cadence — independent of Swing. The SQL aggregation
    // (5-day window over ignition_results) costs ~1.5 s, so we cache and
    // refresh on a slow drumbeat. Errors keep the previous list rather than
    // emptying the tab on a transient DB blip.
    this.continuationCounter += 1;
    const shouldRefreshContinuation =
      this.continuationCounter === 1 ||
      this.continuationCounter % CONTINUATION_REFRESH_CYCLES === 0;
    if (shouldRefreshContinuation) {
      try {
        this.lastContinuation = await getContinuationCandidates(todayEt);
        this.lastContinuationComputedAt = Date.now();
      } catch (err) {
        console.error('[poller] continuation refresh failed:', err);
      }
    }

    // 1) screener — two or three screens in parallel. Momentum + Ignition
    // every cycle; Swing only on the cadence-trigger cycles above.
    const ignitionFilter = session === 'premarket' ? IGNITION.premarket_filter : IGNITION.filter;
    const [rows, ignitionRaw, swingRaw] = await Promise.all([
      fetchScreener({
        filter: this.config.filter,
        floatMaxM: this.config.float_max_m,
        topN: this.config.top_n,
        session,
      }),
      fetchScreener({
        filter: ignitionFilter,
        floatMaxM: IGNITION.float_max_m,
        topN: IGNITION.top_n,
        session,
      }).catch(() => [] as ScreenerRow[]),
      shouldRefreshSwing
        ? fetchScreener({
            filter: SWING.filter,
            floatMaxM: SWING.float_max_m,
            topN: SWING.top_n,
            session,
          }).catch(() => [] as ScreenerRow[])
        : Promise.resolve([] as ScreenerRow[]),
    ]);
    // sh_price_u10 has no lower bound — drop sub-dime junk.
    const ignitionRows = ignitionRaw.filter(
      (r) => r.price != null && r.price >= IGNITION.min_price,
    );
    // Swing post-filters (Finviz can't gate float min, mcap min in-string
    // without dropping null-field rows). Apply both in code.
    const swingRows = swingRaw.filter(
      (r) =>
        r.float_m != null &&
        r.float_m >= SWING.float_min_m &&
        r.float_m <= SWING.float_max_m &&
        r.mcap_m != null &&
        r.mcap_m >= SWING.mcap_min_m,
    );

    // Enrich the union of all active screens once; derive each view afterward.
    const screenRows = new Map<string, ScreenerRow>();
    for (const r of rows) screenRows.set(r.ticker, r);
    for (const r of ignitionRows) if (!screenRows.has(r.ticker)) screenRows.set(r.ticker, r);
    for (const r of swingRows) if (!screenRows.has(r.ticker)) screenRows.set(r.ticker, r);
    const tickers = [...screenRows.keys()];
    // Queue this cycle's tickers for a SEC shelf/dilution lookup. The result
    // lands asynchronously in the shelf cache and is read below via shelf.get.
    shelf.track(tickers);

    // 2) news — five sources in parallel
    const [finvizNews, yahooNews, bzDelta, edgarDelta, haltDelta] = await Promise.all([
      fetchFinvizNews(tickers, todayEt).catch(() => []),
      fetchYahooNews(tickers, todayEt).catch(() => []),
      fetchBenzingaDelta(this.bzWatermark, todayEt).catch(() => null),
      fetchEdgarFilings(new Set(tickers), this.secWatermark).catch(() => null),
      fetchHalts(this.haltWatermark, todayEt).catch(() => null),
    ]);

    // Build per-cycle ticker → headline map. Precedence, low → high:
    //   Finviz < Yahoo < Benzinga < SEC filing < trade halt.
    const cycleNews = new Map<string, NewsHeadline>();
    for (const n of finvizNews) {
      cycleNews.set(n.ticker, {
        ticker: n.ticker,
        source: 'finviz',
        title: n.title,
        url: n.url,
        published_at: parseEtNaiveAsIso(n.date),
      });
    }
    for (const n of yahooNews) {
      cycleNews.set(n.ticker, {
        ticker: n.ticker,
        source: 'yahoo',
        title: n.title,
        url: n.url,
        published_at: n.published_at.toISOString(),
      });
    }

    // Benzinga: persist articles + update cumulative cache + freshness set.
    if (bzDelta) {
      this.bzWatermark = bzDelta.newWatermark;
      for (const a of bzDelta.articles) {
        for (const tk of a.tickers) {
          const headline: NewsHeadline = {
            ticker: tk,
            source: 'benzinga',
            title: a.title,
            url: a.url,
            published_at: a.published_at.toISOString(),
          };
          this.bzHeadlineCache.set(tk, headline);
          // Benzinga overrides any same-cycle Finviz/Yahoo entry for the same ticker.
          cycleNews.set(tk, headline);
        }
      }
    }

    // SEC EDGAR filings — a primary-source catalyst (offerings, 8-Ks, M&A,
    // 13D stakes). Outranks the aggregators: the filing IS the news. Filings
    // arrive newest-first, so the first one per ticker wins.
    if (edgarDelta) {
      this.secWatermark = edgarDelta.newWatermark;
      for (const f of edgarDelta.filings) {
        if (cycleNews.get(f.ticker)?.source === 'sec') continue;
        cycleNews.set(f.ticker, {
          ticker: f.ticker,
          source: 'sec',
          title: f.title,
          url: f.url,
          published_at: f.published_at.toISOString(),
          secForm: f.form,
        });
      }
    }

    // Trade halts — highest precedence. A frozen tape is the loudest signal
    // there is. The feed is market-wide; surface only screener tickers.
    if (haltDelta) {
      this.haltWatermark = haltDelta.newWatermark;
      const onScreen = new Set(tickers);
      for (const h of haltDelta.halts) {
        if (!onScreen.has(h.ticker)) continue;
        if (cycleNews.get(h.ticker)?.source === 'halt') continue;
        cycleNews.set(h.ticker, {
          ticker: h.ticker,
          source: 'halt',
          title: h.title,
          url: h.url,
          published_at: h.haltedAt.toISOString(),
          haltReason: h.reasonCode,
        });
      }
    }

    // Apply persistent Benzinga cache as a base layer for tickers we've seen
    // before — even if they didn't return Finviz/Yahoo this cycle.
    for (const [tk, hl] of this.bzHeadlineCache) {
      if (!cycleNews.has(tk)) cycleNews.set(tk, hl);
    }

    // "Fresh this cycle" = audio-worthy. Any delta source can contribute: a
    // new Benzinga article, a just-disseminated SEC filing, or a new halt.
    const freshTickers = new Set<string>([
      ...(bzDelta?.freshTickers ?? []),
      ...(edgarDelta?.freshTickers ?? []),
      ...(haltDelta?.freshTickers ?? []),
    ]);

    // 3) classify rows + compute 5-min relative volume + build payload
    const nowSec = Math.floor(Date.now() / 1000);
    const FIVE_MIN_SEC = 300;
    // Before a 5-min-old anchor exists, the burst is extrapolated from the
    // oldest sample once the window is at least this wide — so a fresh
    // ignition is measurable in ~80s, not 5 min (see the CNEY post-mortem).
    const MIN_WINDOW_SEC = 75;
    const HISTORY_MAX_SEC = 600;
    // Trading day = 6.5h × 60min ÷ 5min = 78 five-min slices. The 5-min "rate %"
    // baseline is the volume that would flow in a typical such slice.
    const SLICES_PER_DAY = 78;

    const enrichRow = (r: ScreenerRow): EnrichedRow => {
      const prev = this.prevChange.get(r.ticker);
      const cur = r.change_pct ?? 0;
      let status: RowStatus = null;
      let accelDelta: number | null = null;

      if (prev === undefined) {
        status = 'NEW';
      } else if (cur !== prev) {
        const d = +(cur - prev).toFixed(2);
        accelDelta = d;
        if (d > this.config.accel_threshold) status = 'ACC';
        else if (d > 0) status = 'UP';
      }

      // 5-min volume rate. Diff cumulative-day-volume against an anchor sample
      // >= 5 min old for the exact rate. Before such a sample exists, fall back
      // to the oldest sample we have (once the window is wide enough) and
      // extrapolate it to a 5-min-equivalent — so a fresh ignition's volume
      // burst is measurable within ~80s of first appearing, not 5 minutes.
      let vol5min: number | null = null;
      let relVol5min: number | null = null;
      if (r.volume != null) {
        let h = this.volHistory.get(r.ticker);
        if (!h) {
          h = [];
          this.volHistory.set(r.ticker, h);
        }
        const fiveMinAnchor = h.find((p) => nowSec - p.ts >= FIVE_MIN_SEC);
        if (fiveMinAnchor) {
          const diff = r.volume - fiveMinAnchor.volume;
          if (diff >= 0) vol5min = diff;
        } else if (h.length > 0 && nowSec - h[0].ts >= MIN_WINDOW_SEC) {
          // Cold start — extrapolate the short window to a 5-min-equivalent.
          const dt = nowSec - h[0].ts;
          const diff = r.volume - h[0].volume;
          if (diff >= 0) vol5min = Math.round(diff * (FIVE_MIN_SEC / dt));
        }
        if (vol5min != null && r.avg_volume && r.avg_volume > 0) {
          const expected5min = r.avg_volume / SLICES_PER_DAY;
          if (expected5min > 0) {
            relVol5min = +((vol5min / expected5min) * 100).toFixed(2);
          }
        }
        // Append current sample, trim history.
        h.push({ ts: nowSec, volume: r.volume });
        while (h.length > 0 && nowSec - h[0].ts > HISTORY_MAX_SEC) h.shift();
      }

      // Anchored VWAP — see EnrichedRow.vwap doc. First cycle seeds lastVolume
      // and returns null (no delta yet). Subsequent cycles accumulate
      // Δvolume × current price; reset is handled by the session-boundary
      // clear above, so each session carries its own anchor.
      let vwap: number | null = null;
      let aboveVwap: boolean | null = null;
      if (r.price != null && r.price > 0 && r.volume != null) {
        const st = this.vwapState.get(r.ticker);
        if (!st) {
          this.vwapState.set(r.ticker, { cumPxVol: 0, cumVol: 0, lastVolume: r.volume });
        } else {
          const dv = r.volume - st.lastVolume;
          if (dv > 0) {
            st.cumPxVol += dv * r.price;
            st.cumVol += dv;
          }
          st.lastVolume = r.volume;
          if (st.cumVol > 0) {
            vwap = +(st.cumPxVol / st.cumVol).toFixed(4);
            aboveVwap = r.price >= vwap;
          }
        }
      }

      const headline = cycleNews.get(r.ticker) ?? null;
      const hasNews = !!headline;
      const isFresh = freshTickers.has(r.ticker);

      // If no movement classification but has news, mark NEWS.
      if (status == null && hasNews) status = 'NEWS';

      // Catalyst score — read from the URL cache, or compute fresh via rules.
      let catalyst: CatalystInfo | null = null;
      if (headline) {
        let cached = this.classificationCache.get(headline.url);
        if (!cached) {
          const input: ClassifierInput = {
            ticker: r.ticker,
            title: headline.title,
            source: headline.source,
            secForm: headline.secForm,
            haltReason: headline.haltReason,
            marketContext: {
              change_pct: r.change_pct,
              float_m: r.float_m,
              mcap_m: r.mcap_m,
              rel_volume: r.rel_volume,
              country: r.country,
            },
          };
          const cls = classifyByRules(input);
          cached = {
            classification: cls,
            classifier: 'rules',
            // SEC filings and halts are classified deterministically from
            // their form/reason code — the rule verdict is final, not a
            // baseline for the LLM to refine.
            needsLLM: !!process.env.ANTHROPIC_API_KEY
              && headline.source !== 'sec' && headline.source !== 'halt',
            input,
          };
          this.classificationCache.set(headline.url, cached);
        }
        catalyst = {
          score: cached.classification.impact_score,
          urgency: cached.classification.urgency,
          direction: cached.classification.direction,
          type: cached.classification.catalyst_type,
          reason: cached.classification.reason,
          risk_flags: cached.classification.risk_flags,
          classifier: cached.classifier,
        };
      }

      return {
        ...r,
        status,
        prev_change_pct: prev ?? null,
        accel_delta: accelDelta,
        vol_5min: vol5min,
        rel_vol_5min: relVol5min,
        vwap,
        above_vwap: aboveVwap,
        is_fresh_news: isFresh,
        has_today_news: hasNews,
        news_title: headline?.title ?? null,
        news_source: headline?.source ?? null,
        news_url: headline?.url ?? null,
        finviz_url: `https://elite.finviz.com/quote?t=${r.ticker}&ty=c&p=h&b=1`,
        catalyst,
        shelf: shelf.get(r.ticker),
      };
    };

    // Enrich every ticker once (volHistory side-effects fire once per ticker),
    // then split into the two screen views.
    const enrichedByTicker = new Map<string, EnrichedRow>();
    for (const r of screenRows.values()) enrichedByTicker.set(r.ticker, enrichRow(r));
    const enriched = rows.map((r) => enrichedByTicker.get(r.ticker)!);

    // Track Ignition-set membership so just-arrived names can be surfaced
    // separately. Register first-sightings, then prune any ticker no longer
    // present — this keeps each survivor's firstSeen stable while letting a
    // ticker that leaves and returns re-count as new.
    const nowMs = Date.now();
    for (const r of ignitionRows) {
      if (!this.ignitionFirstSeen.has(r.ticker)) this.ignitionFirstSeen.set(r.ticker, nowMs);
    }
    const ignitionPresent = new Set(ignitionRows.map((r) => r.ticker));
    for (const t of this.ignitionFirstSeen.keys()) {
      if (!ignitionPresent.has(t)) this.ignitionFirstSeen.delete(t);
    }

    const scoredIgnition: IgnitionRow[] = ignitionRows
      .map((r) => {
        const e = enrichedByTicker.get(r.ticker)!;
        const rs = scoreRunner({
          float_m: e.float_m,
          rel_vol_5min: e.rel_vol_5min,
          rel_volume: e.rel_volume,
          catalyst_score: e.catalyst?.score ?? null,
          catalyst_direction: e.catalyst?.direction ?? null,
          change_pct: e.change_pct,
          is_halt: e.news_source === 'halt',
          shelf_level: e.shelf?.level ?? null,
        });
        const firstSeen = this.ignitionFirstSeen.get(r.ticker) ?? nowMs;
        return {
          ...e,
          runner_score: rs.score,
          score_breakdown: rs.breakdown,
          is_new: nowMs - firstSeen <= IGNITION.new_window_ms,
        };
      })
      .sort((a, b) => b.runner_score - a.runner_score);

    // Drop rows the runner-score has already disqualified (clamped to 0).
    // The volume-led Finviz filter has no change% gate by design, so it lets
    // through crashes and low-quality dilution-flagged names — the score
    // tags them as non-ignitions; the broadcast shouldn't carry them. This
    // does NOT hide cold-start fresh entries (they score ≥ float-component
    // ≈ 15-30) or volume-led turnaround setups (they score 48+).
    const candidates = scoredIgnition.filter((r) => r.runner_score > 0);
    // New rows bypass the score cutoff entirely — a fresh low-score name (its
    // 5-min RVol not yet measurable) must never be buried. Top rows are the
    // established names, ranked and capped. The payload carries both.
    const newIgnition = candidates.filter((r) => r.is_new);
    const topIgnition = candidates.filter((r) => !r.is_new).slice(0, IGNITION.broadcast_n);
    const ignition: IgnitionRow[] = [...newIgnition, ...topIgnition];

    // 3b) Swing scoring — only on the cadence-trigger cycles. Reads daily
    // bars from the daily_bars table (populated by the DailyBarsService);
    // scores each ticker in the post-filtered Swing universe; sorts desc;
    // truncates to SWING.broadcast_n. On non-trigger cycles we keep the
    // previous cached list (lastSwingRows) so the SSE clients still see it.
    let scoredSwing: SwingRow[] = this.lastSwingRows;
    let swingFreshlyScored = false;
    if (shouldRefreshSwing) {
      const swingTickers = swingRows.map((r) => r.ticker);
      // Queue every swing-universe ticker for daily-bar backfill — tickers
      // already fresh in the service are no-ops, new ones get queued.
      dailyBars.trackUniverse(swingTickers);
      const barsByTicker = await getRecentBarsForTickers(swingTickers, 252);
      const scored: SwingRow[] = [];
      for (const r of swingRows) {
        const e = enrichedByTicker.get(r.ticker)!;
        const result = scoreSwing({
          price: e.price,
          volume: e.volume,
          bars: barsByTicker.get(r.ticker) ?? [],
          catalyst_score: e.catalyst?.score ?? null,
          catalyst_direction: e.catalyst?.direction ?? null,
          catalyst_urgency: e.catalyst?.urgency ?? null,
          catalyst_type: e.catalyst?.type ?? null,
          shelf_level: e.shelf?.level ?? null,
        });
        if (!result) continue;
        scored.push({
          ...e,
          swing_score: result.score,
          score_breakdown: result.breakdown,
          setup_flags: result.flags,
          daily_context: result.context,
        });
      }
      scored.sort((a, b) => b.swing_score - a.swing_score);
      const truncated = scored.slice(0, SWING.broadcast_n);
      // Replace only if the new scan actually produced rows — a transient
      // Finviz hiccup shouldn't blank out the swing list.
      if (truncated.length > 0) {
        this.lastSwingRows = truncated;
        this.lastSwingComputedAt = Date.now();
        scoredSwing = truncated;
        swingFreshlyScored = true;
      }
      if (isPostCloseTrigger) this.lastForcedSwingPostCloseDate = todayEt;
    }

    // 4) update memory state for next cycle
    for (const r of screenRows.values()) {
      if (r.change_pct != null) this.prevChange.set(r.ticker, r.change_pct);
    }

    // 5) persist — Swing rows only on the cycles that re-scored, so the
    // swing_results table holds one snapshot per ~20 min, not per 20 s.
    const cycleId = await this.persistCycle(
      session, enriched, ignition, swingFreshlyScored ? scoredSwing : [],
      bzDelta?.articles, finvizNews, yahooNews,
      edgarDelta?.filings, haltDelta?.halts,
    );

    // 6) broadcast
    const newWithCatalyst = enriched
      .filter((r) => r.status === 'NEW' && r.has_today_news)
      .map((r) => r.ticker);
    const freshList = enriched.filter((r) => r.is_fresh_news).map((r) => r.ticker);

    const payload: CyclePayload = {
      cycle_id: cycleId,
      polled_at: new Date().toISOString(),
      session,
      config: this.config,
      rows: enriched,
      ignition,
      swing: scoredSwing,
      continuation: this.lastContinuation,
      banners: { new_with_catalyst: newWithCatalyst, fresh_news: freshList },
      fresh_news: enriched
        .filter((r) => r.is_fresh_news && r.news_title)
        .map((r) => ({
          ticker: r.ticker,
          source: r.news_source!,
          title: r.news_title!,
          url: r.news_url!,
          published_at: cycleNews.get(r.ticker)?.published_at ?? null,
        })),
    };

    this.lastPayload = payload;
    const wasFirstPoll = this.firstPoll;
    this.firstPoll = false;
    broadcast('cycle', payload);
    console.log(
      `[poller] ${nowHms()} — ${enriched.length} rows, ${ignition.length} ignition, ${scoredSwing.length} swing${swingFreshlyScored ? ' (refreshed)' : ''}, ${this.lastContinuation.length} continuation${shouldRefreshContinuation ? ' (refreshed)' : ''}, ${newWithCatalyst.length} new+catalyst, ${freshList.length} fresh`,
    );

    // Telegram alerts — fresh high-impact rows + Ignition runner-score hits.
    // Skipped on the first poll so a restart's news backfill and cold-start
    // ignition set don't blast a burst of alerts. Swing alerts only fire on
    // cycles where the swing scan freshly ran (otherwise we'd re-walk the
    // cached list every cycle, doing no work but for no reason).
    if (!wasFirstPoll) {
      this.pushAlerts(enriched);
      this.pushIgnitionAlerts(ignition);
      if (swingFreshlyScored) this.pushSwingAlerts(scoredSwing);
      this.pushDualSignalAlerts(ignition);
    }

    // Fire-and-forget LLM refinement of any rule-classified articles.
    // Completes in the background; the next cycle's payload picks up the
    // refined scores via the in-memory cache.
    void this.refineWithLLM();
  }

  // Run the LLM classifier on every article still flagged needsLLM (i.e.
  // classified by rules and persisted, but not yet refined). Bounded
  // concurrency keeps us from hammering the API. Skipped entirely if a
  // previous run is still in flight, so a slow API doesn't queue up
  // infinite work.
  private async refineWithLLM() {
    if (this.llmInFlight) return;
    if (!process.env.ANTHROPIC_API_KEY) return;

    const pending = [...this.classificationCache.values()].filter(
      (v) => v.needsLLM && v.articleId,
    );
    if (pending.length === 0) return;

    this.llmInFlight = true;
    try {
      const concurrency = 5;
      for (let i = 0; i < pending.length; i += concurrency) {
        const batch = pending.slice(i, i + concurrency);
        await Promise.all(batch.map((entry) => this.refineOne(entry)));
      }
    } finally {
      this.llmInFlight = false;
    }
  }

  private async refineOne(entry: {
    classification: Classification;
    classifier: Classifier;
    articleId?: string;
    needsLLM: boolean;
    input: ClassifierInput;
  }): Promise<void> {
    const result = await classifyByClaude(entry.input);
    if (!result || !entry.articleId) {
      // Give up after one failure — don't burn tokens retrying every cycle.
      entry.needsLLM = false;
      return;
    }
    entry.classification = result;
    entry.classifier = 'anthropic_sonnet';
    entry.needsLLM = false;

    try {
      await getDb()
        .updateTable('news_classifications')
        .set({
          impact_score: result.impact_score,
          direction: result.direction,
          urgency: result.urgency,
          catalyst_type: result.catalyst_type,
          materiality: result.materiality,
          confidence: result.confidence,
          reason: result.reason,
          risk_flags: JSON.stringify(result.risk_flags) as unknown as never,
          classifier: 'anthropic_sonnet',
          updated_at: new Date(),
        })
        .where('article_id', '=', entry.articleId)
        .execute();
    } catch (err) {
      console.error('[poller] failed to persist Claude classification:', err);
    }
  }

  private async persistCycle(
    session: TradingSession,
    rows: EnrichedRow[],
    ignitionRows: IgnitionRow[],
    swingRows: SwingRow[],
    bzArticles: import('./benzinga.js').BenzingaArticle[] | undefined,
    finvizNews: Awaited<ReturnType<typeof fetchFinvizNews>>,
    yahooNews: Awaited<ReturnType<typeof fetchYahooNews>>,
    edgarFilings: EdgarFiling[] | undefined,
    halts: TradeHalt[] | undefined,
  ): Promise<string> {
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      const cycle = await trx
        .insertInto('screener_cycles')
        .values({
          filter_snapshot: JSON.stringify(this.config),
          row_count: rows.length,
          session,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (rows.length > 0) {
        await trx
          .insertInto('screener_results')
          .values(
            rows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              change_pct: r.change_pct,
              float_m: r.float_m,
              float_is_proxy: r.float_is_proxy,
              price: r.price,
              volume: r.volume,
              avg_volume: r.avg_volume,
              rel_volume: r.rel_volume,
              vol_5min: r.vol_5min,
              rel_vol_5min: r.rel_vol_5min,
              mcap_m: r.mcap_m,
              country: r.country,
              company: r.company,
              sector: r.sector,
              industry: r.industry,
              short_float_pct: r.short_float_pct,
              short_ratio: r.short_ratio,
              insider_own_pct: r.insider_own_pct,
              insider_trans_pct: r.insider_trans_pct,
              inst_own_pct: r.inst_own_pct,
              inst_trans_pct: r.inst_trans_pct,
              shares_out_m: r.shares_out_m,
              status: r.status,
              prev_change_pct: r.prev_change_pct,
              accel_delta: r.accel_delta,
            })),
          )
          .execute();
      }

      if (ignitionRows.length > 0) {
        await trx
          .insertInto('ignition_results')
          .values(
            ignitionRows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              runner_score: r.runner_score,
              score_breakdown: JSON.stringify(r.score_breakdown) as unknown as never,
              price: r.price,
              change_pct: r.change_pct,
              float_m: r.float_m,
              rel_volume: r.rel_volume,
              rel_vol_5min: r.rel_vol_5min,
              catalyst_score: r.catalyst?.score ?? null,
              news_source: r.news_source,
              shelf_level: r.shelf?.level ?? null,
            })),
          )
          .execute();
      }

      if (swingRows.length > 0) {
        await trx
          .insertInto('swing_results')
          .values(
            swingRows.map((r) => ({
              cycle_id: cycle.id,
              ticker: r.ticker,
              swing_score: r.swing_score,
              score_breakdown: JSON.stringify(r.score_breakdown) as unknown as never,
              price: r.price,
              change_pct: r.change_pct,
              float_m: r.float_m,
              mcap_m: r.mcap_m,
              volume: r.volume,
              avg_volume_20: r.daily_context.avg_volume_20,
              sma_20: r.daily_context.sma_20,
              sma_50: r.daily_context.sma_50,
              sma_200: r.daily_context.sma_200,
              high_52w: r.daily_context.high_52w,
              atr_14: r.daily_context.atr_14,
              in_base: r.setup_flags.in_base,
              broke_out: r.setup_flags.broke_out,
              close_in_top_q: r.setup_flags.close_in_top_q,
              catalyst_score: r.catalyst?.score ?? null,
              catalyst_type: r.catalyst?.type ?? null,
              shelf_level: r.shelf?.level ?? null,
            })),
          )
          .execute();
      }

      // News persistence — dedup by URL via ON CONFLICT DO NOTHING.
      type Pending = { source: NewsSource; url: string; title: string; published_at: Date | null; raw: unknown; tickers: string[] };
      const pending: Pending[] = [];

      for (const a of bzArticles ?? []) {
        if (!a.url) continue;
        pending.push({
          source: 'benzinga',
          url: a.url,
          title: a.title,
          published_at: a.published_at,
          raw: a.raw,
          tickers: a.tickers,
        });
      }
      for (const n of finvizNews) {
        if (!n.url) continue;
        pending.push({
          source: 'finviz',
          url: n.url,
          title: n.title,
          published_at: parseEtNaiveAsDate(n.date),
          raw: n,
          tickers: [n.ticker],
        });
      }
      for (const n of yahooNews) {
        if (!n.url) continue;
        pending.push({
          source: 'yahoo',
          url: n.url,
          title: n.title,
          published_at: n.published_at,
          raw: n,
          tickers: [n.ticker],
        });
      }
      for (const f of edgarFilings ?? []) {
        if (!f.url) continue;
        pending.push({
          source: 'sec',
          url: f.url,
          title: f.title,
          published_at: f.published_at,
          raw: f.raw,
          tickers: [f.ticker],
        });
      }
      for (const h of halts ?? []) {
        if (!h.url) continue;
        pending.push({
          source: 'halt',
          url: h.url,
          title: h.title,
          published_at: h.haltedAt,
          raw: h.raw,
          tickers: [h.ticker],
        });
      }

      for (const p of pending) {
        const inserted = await trx
          .insertInto('news_articles')
          .values({
            source: p.source,
            url: p.url,
            title: p.title,
            published_at: p.published_at,
            raw: JSON.stringify(p.raw) as unknown as never,
          })
          .onConflict((oc) => oc.column('url').doNothing())
          .returning('id')
          .executeTakeFirst();

        const articleId = inserted?.id
          ?? (await trx.selectFrom('news_articles').select('id').where('url', '=', p.url).executeTakeFirst())?.id;

        if (!articleId) continue;

        for (const tk of p.tickers) {
          await trx
            .insertInto('news_ticker_links')
            .values({ article_id: articleId, ticker: tk })
            .onConflict((oc) => oc.columns(['article_id', 'ticker']).doNothing())
            .execute();
        }

        // Persist the rule-based classification once per article. The OpenAI
        // pass writes the same row later via UPDATE — `do nothing` here means
        // we never clobber a refined verdict with the cached rule one.
        const cached = this.classificationCache.get(p.url);
        if (cached) {
          cached.articleId = articleId; // unlock LLM refinement for this article
          await trx
            .insertInto('news_classifications')
            .values({
              article_id: articleId,
              impact_score: cached.classification.impact_score,
              direction: cached.classification.direction,
              urgency: cached.classification.urgency,
              catalyst_type: cached.classification.catalyst_type,
              materiality: cached.classification.materiality,
              confidence: cached.classification.confidence,
              reason: cached.classification.reason,
              risk_flags: JSON.stringify(cached.classification.risk_flags) as unknown as never,
              classifier: cached.classifier,
            })
            .onConflict((oc) => oc.column('article_id').doNothing())
            .execute();
        }
      }

      return cycle.id;
    });
  }

  // Push a Telegram alert for any fresh, high-impact, non-bearish row — once
  // per article URL. `is_fresh_news` is already a near one-shot signal (true
  // only while the article is newer than the source watermark); alertedUrls
  // guards the rest.
  private pushAlerts(rows: EnrichedRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      if (!r.is_fresh_news || !r.catalyst || !r.news_url) continue;
      if (r.catalyst.urgency !== 'strong' && r.catalyst.urgency !== 'major') continue;
      // Direction-aware, like the Ignition path: a bearish strong/major
      // catalyst (dilutive offering, SEC probe, regulatory halt) is why a
      // stock falls — not a runner to chase. Neutral signals such as a T1
      // "news pending" halt still alert.
      if (r.catalyst.direction === 'bearish') continue;
      if (this.alertedUrls.has(r.news_url)) continue;
      this.alertedUrls.add(r.news_url);
      void sendTelegram(formatTelegramAlert(r));
    }
  }

  // Telegram alert for an Ignition row — once per ticker per ET day. Fires on
  // either trigger: the runner-score clearing the threshold (a mechanical
  // ignition), OR a bullish strong/major catalyst (catches a catalyst-led move
  // before the volume burst lifts the score). Bearish catalysts never alert.
  private pushIgnitionAlerts(rows: IgnitionRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      const c = r.catalyst;
      const bullishCatalyst =
        c != null && c.direction === 'bullish' && (c.urgency === 'strong' || c.urgency === 'major');
      // Test the threshold against the score with the shelf penalty removed:
      // dilution risk ranks the sidebar and rides as the ⚠️ in the message,
      // but it must not *hide* an ignition from the alert. Detection and risk
      // are separate concerns.
      const b = r.score_breakdown;
      const detectionScore = b.float + b.volume + b.catalyst + b.earliness + b.halt;
      if (detectionScore < IGNITION.alert_score && !bullishCatalyst) continue;
      if (this.alertedIgnition.has(r.ticker)) continue;
      // Entry change% cap — see IGNITION.alert_entry_chg_max comment. We skip
      // *without* adding to alertedIgnition, so a pullback under the cap on a
      // later cycle still earns a fresh alert (the second-leg setup).
      if (r.change_pct != null && r.change_pct > IGNITION.alert_entry_chg_max) continue;
      this.alertedIgnition.add(r.ticker);
      void sendTelegram(formatIgnitionAlert(r));
    }
  }

  // Dual-signal alert — fires the first time a Continuation ticker (≥ 2 days
  // of Ignition history) also clears the live Ignition score floor on the
  // same cycle. The CODX-day-2/3 trigger: the *confirmation* that the move
  // is multi-day, not just a one-session pump. Dedup once per ticker per ET
  // day. Bullish-only: a continuation candidate with a fresh bearish
  // catalyst is a fade-in-progress, not a runner. No entry-change% cap here
  // because the multi-day prior is itself the entry-quality filter (these
  // names are already extended *by design* — we want to alert the trader
  // anyway so they can read the chart and decide).
  private pushDualSignalAlerts(rows: IgnitionRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    if (this.lastContinuation.length === 0) return;
    // Index the continuation list once per cycle for O(1) ticker lookup.
    const contBy = new Map<string, ContinuationCandidate>();
    for (const c of this.lastContinuation) contBy.set(c.ticker, c);
    for (const r of rows) {
      const cont = contBy.get(r.ticker);
      if (!cont) continue;
      if (this.alertedDualSignal.has(r.ticker)) continue;
      if (r.runner_score < DUAL_SIGNAL.min_ignition_score) continue;
      // Skip bearish catalysts and crashing moves — same direction-awareness
      // as the Ignition alert path.
      if (r.catalyst?.direction === 'bearish') continue;
      if (r.change_pct != null && r.change_pct < 0) continue;
      this.alertedDualSignal.add(r.ticker);
      void sendTelegram(formatDualSignalAlert(r, cont));
    }
  }

  // Telegram alert for a Swing row — once per ticker per ET day. Trigger:
  // swing_score ≥ SWING.alert_score AND either the 10-day breakout flag is
  // set OR a bullish strong/major catalyst landed this cycle. The catalyst
  // clause matches the alert criteria in docs/swing-screener-spec.md §7 —
  // a fresh durable catalyst is alert-worthy even on a clean trend without
  // a textbook breakout. Bearish catalysts never alert.
  private pushSwingAlerts(rows: SwingRow[]): void {
    if (!telegramEnabled() || this.alertsMuted) return;
    for (const r of rows) {
      if (this.alertedSwing.has(r.ticker)) continue;
      if (r.swing_score < SWING.alert_score) continue;
      const c = r.catalyst;
      const freshBullishCatalyst =
        r.is_fresh_news &&
        c != null &&
        c.direction === 'bullish' &&
        (c.urgency === 'strong' || c.urgency === 'major');
      if (!r.setup_flags.broke_out && !freshBullishCatalyst) continue;
      this.alertedSwing.add(r.ticker);
      void sendTelegram(formatSwingAlert(r));
    }
  }
}

export const poller = new PollerService();

// Render a screener row as a Telegram HTML-mode message.
function formatTelegramAlert(r: EnrichedRow): string {
  const c = r.catalyst!;
  const emoji = r.news_source === 'halt' ? '🛑' : c.urgency === 'major' ? '🔥' : '🚨';
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;

  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_volume != null) meta.push(`RVol ${Math.round(r.rel_volume)}x`);
  if (r.status) meta.push(r.status);

  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const links = [`<a href="${escapeHtml(r.finviz_url)}">Finviz</a>`, `<a href="${tv}">TradingView</a>`];
  if (r.news_url) links.unshift(`<a href="${escapeHtml(r.news_url)}">News</a>`);

  const lines = [
    `${emoji} <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    meta.join(' · '),
    `<b>${c.urgency.toUpperCase()}</b> catalyst · score ${c.score} · ${escapeHtml(c.type)} (${c.direction})`,
    r.news_title ? `“${escapeHtml(r.news_title)}”${r.news_source ? ` — ${r.news_source}` : ''}` : '',
    c.risk_flags.length > 0 ? `⚠️ ${escapeHtml(c.risk_flags.join(', '))}` : '',
    shelfAlertLine(r.shelf),
    links.join(' · '),
  ];
  return lines.filter(Boolean).join('\n');
}

// One-line dilution warning for a Telegram alert. Empty when no shelf is on
// file — the kill-switch line only shows when there is something to flag.
function shelfAlertLine(s: ShelfInfo | null): string {
  if (!s) return '';
  const label =
    s.level === 'active' ? 'ACTIVE OFFERING'
    : s.level === 'effective' ? 'EFFECTIVE SHELF'
    : 'SHELF ON FILE';
  return `⚠️ ${label} · dilution risk — ${escapeHtml(s.latest_form)}, ${s.days_since}d ago`;
}

// Render an Ignition row as a Telegram HTML-mode message.
function formatIgnitionAlert(r: IgnitionRow): string {
  const b = r.score_breakdown;
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.catalyst) meta.push(`catalyst ${r.catalyst.score}`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `⚡ <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>Ignition ${r.runner_score}</b> · float ${b.float} / vol ${b.volume} / cat ${b.catalyst} / early ${b.earliness} / halt ${b.halt} / shelf ${b.shelf}`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a dual-signal alert — a Continuation candidate (≥ 2 days of
// Ignition history) that also has a meaningful live Ignition score this
// cycle. The narrative is "this isn't day 1 — the move is confirming";
// the message leads with the day count + score trajectory rather than
// the raw runner-score, then folds in the live Ignition meta + catalyst.
function formatDualSignalAlert(r: IgnitionRow, c: ContinuationCandidate): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const firstSeenMd = c.first_seen.slice(5);  // MM-DD
  const trajectory = `Day ${c.days_seen} · score ${Math.round(c.first_day_peak)} → ${Math.round(r.runner_score)}`;
  const meta: string[] = [];
  if (r.float_m != null) meta.push(`float ${r.float_m.toFixed(1)}M`);
  if (r.rel_vol_5min != null) meta.push(`RVol5m ${Math.round(r.rel_vol_5min)}%`);
  if (r.catalyst) meta.push(`catalyst ${r.catalyst.score}`);
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `🎯 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>${trajectory}</b> · first seen ${firstSeenMd} · multi-day setup confirming`,
    meta.join(' · '),
    r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

// Render a Swing row as a Telegram HTML-mode message. The flag strip
// surfaces the trigger reason at a glance — 📈 base/breakout pattern,
// 🔥 fresh catalyst — and the daily-context line carries the
// swing-trader's eye-line metrics (vs 52WH, vs 20-SMA, Vol×Avg).
function formatSwingAlert(r: SwingRow): string {
  const b = r.score_breakdown;
  const ctx = r.daily_context;
  const flags = r.setup_flags;
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;

  // Eye-line metrics — empty when the daily-bar context wasn't deep enough.
  const eyes: string[] = [];
  if (ctx.dist_52w_high_pct != null) {
    eyes.push(`52WH ${ctx.dist_52w_high_pct >= 0 ? '+' : ''}${ctx.dist_52w_high_pct.toFixed(1)}%`);
  }
  if (ctx.sma_20 != null && r.price != null && ctx.sma_20 > 0) {
    const pct = ((r.price - ctx.sma_20) / ctx.sma_20) * 100;
    eyes.push(`20SMA ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
  }
  if (r.volume != null && ctx.avg_volume_20 != null && ctx.avg_volume_20 > 0) {
    eyes.push(`Vol×Avg ${(r.volume / ctx.avg_volume_20).toFixed(1)}×`);
  }

  // Trigger label — what got this past the gate.
  const trigger = flags.broke_out
    ? '📈 10-day breakout'
    : '🔥 fresh catalyst';

  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.ticker)}`;
  const lines = [
    `📊 <b>${escapeHtml(r.ticker)}</b>  ${price}  ${chg}`.trimEnd(),
    `<b>Swing ${r.swing_score}</b> · ${trigger} · trend ${b.trend} / setup ${b.setup} / vol ${b.volume} / cat ${b.catalyst} / shelf ${b.shelf}`,
    eyes.join(' · '),
    r.catalyst && r.news_title ? `“${escapeHtml(r.news_title)}”` : '',
    shelfAlertLine(r.shelf),
    `<a href="${escapeHtml(r.finviz_url)}">Finviz</a> · <a href="${tv}">TradingView</a>`,
  ];
  return lines.filter(Boolean).join('\n');
}

function nowHms(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function etDateString(dt: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

// Minute-of-day in ET (0–1439). Used for the Swing post-close trigger
// (16:30 ET = 990); cheaper than re-running the full Intl parse twice.
function etMinuteOfDay(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  return hour * 60 + parseInt(parts.minute, 10);
}

// Maps a moment to its US-equities trading session by ET wall-clock:
//   premarket   04:00–09:30 ET
//   regular     09:30–16:00 ET
//   afterhours  16:00–20:00 ET
//   closed      everything else (overnight + weekends)
// Holidays are not special-cased — on a holiday Finviz simply returns no
// movers, so the session label is cosmetically off but the screen is empty.
function currentEtSession(at: Date): TradingSession {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds emit '24' for midnight
  const mins = hour * 60 + parseInt(parts.minute, 10);
  if (mins >= 240 && mins < 570) return 'premarket';   // 04:00–09:30
  if (mins >= 570 && mins < 960) return 'regular';     // 09:30–16:00
  if (mins >= 960 && mins < 1200) return 'afterhours'; // 16:00–20:00
  return 'closed';
}

// Finviz news dates look like "2026-05-03 09:31:00" with no TZ — they're ET-local.
// Convert to a Date by treating as ET wall-clock time.
function parseEtNaiveAsDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  // Build an ISO string with -05:00 / -04:00 offset depending on DST.
  // Cheapest correct approach: build a UTC time from ET wall-clock by asking
  // Intl what the offset is on that date.
  const utcGuess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const offsetMs = etOffsetMs(utcGuess);
  return new Date(utcGuess.getTime() - offsetMs);
}

function parseEtNaiveAsIso(s: string): string | null {
  const dt = parseEtNaiveAsDate(s);
  return dt ? dt.toISOString() : null;
}

function etOffsetMs(at: Date): number {
  // Get ET clock components for `at`, then compute the difference between
  // that clock and UTC clock.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const etMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return etMs - at.getTime();
}

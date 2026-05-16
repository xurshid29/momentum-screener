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
import { classifyByRules, type Classification, type ClassifierInput } from './catalyst-rules.js';
import { classifyByOpenAI } from './catalyst-openai.js';

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
}

export interface EnrichedRow extends ScreenerRow {
  status: RowStatus;
  prev_change_pct: number | null;
  accel_delta: number | null;
  vol_5min: number | null;          // diffed cumulative volume over the last ~5 minutes
  rel_vol_5min: number | null;      // (vol_5min / (avg_volume / 78)) * 100
  is_fresh_news: boolean;
  has_today_news: boolean;
  news_title: string | null;
  news_source: NewsSource | null;
  news_url: string | null;
  finviz_url: string;
  catalyst: CatalystInfo | null;
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
      // Reset the SEC/halt delta watermarks so the new day's first cycle
      // doesn't replay the whole backlog as "fresh".
      this.secWatermark = Math.floor(now.getTime() / 1000);
      this.haltWatermark = Math.floor(now.getTime() / 1000);
      this.lastEtDate = todayEt;
    }
    // A session boundary (notably the 4pm regular→after-hours flip) swaps the
    // change basis entirely. Drop per-ticker movement state so the jump isn't
    // misread as a huge acceleration on the new session's first cycle.
    if (session !== this.lastSession) {
      this.prevChange.clear();
      this.volHistory.clear();
      this.lastSession = session;
    }

    // 1) screener
    const rows = await fetchScreener({
      filter: this.config.filter,
      floatMaxM: this.config.float_max_m,
      topN: this.config.top_n,
      session,
    });

    const tickers = rows.map((r) => r.ticker);

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
    const HISTORY_MAX_SEC = 600;
    // Trading day = 6.5h × 60min ÷ 5min = 78 five-min slices. The 5-min "rate %"
    // baseline is the volume that would flow in a typical such slice.
    const SLICES_PER_DAY = 78;

    const enriched: EnrichedRow[] = rows.map((r) => {
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

      // 5-min volume rate. We diff cumulative-day-volume against the oldest
      // sample we have that's at least 5 minutes old. If we don't have one
      // yet (cold start within 5 min), leave null.
      let vol5min: number | null = null;
      let relVol5min: number | null = null;
      if (r.volume != null) {
        let h = this.volHistory.get(r.ticker);
        if (!h) {
          h = [];
          this.volHistory.set(r.ticker, h);
        }
        // Find anchor sample >= 5 min old
        const anchor = h.find((p) => nowSec - p.ts >= FIVE_MIN_SEC);
        if (anchor) {
          const diff = r.volume - anchor.volume;
          if (diff >= 0) vol5min = diff;
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
            needsLLM: !!process.env.OPENAI_API_KEY
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
        is_fresh_news: isFresh,
        has_today_news: hasNews,
        news_title: headline?.title ?? null,
        news_source: headline?.source ?? null,
        news_url: headline?.url ?? null,
        finviz_url: `https://elite.finviz.com/quote?t=${r.ticker}&ty=c&p=h&b=1`,
        catalyst,
      };
    });

    // 4) update memory state for next cycle
    for (const r of rows) {
      if (r.change_pct != null) this.prevChange.set(r.ticker, r.change_pct);
    }

    // 5) persist
    const cycleId = await this.persistCycle(
      session, enriched, bzDelta?.articles, finvizNews, yahooNews,
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
    this.firstPoll = false;
    broadcast('cycle', payload);
    console.log(
      `[poller] ${nowHms()} — ${enriched.length} rows, ${newWithCatalyst.length} new+catalyst, ${freshList.length} fresh`,
    );

    // Fire-and-forget LLM refinement of any rule-classified articles.
    // Completes in the background; the next cycle's payload picks up the
    // refined scores via the in-memory cache.
    void this.refineWithOpenAI();
  }

  // Run OpenAI on every article still flagged needsLLM (i.e. classified by
  // rules and persisted, but not yet refined). Bounded concurrency keeps
  // us from hammering the API. Skipped entirely if a previous run is still
  // in flight, so a slow API doesn't queue up infinite work.
  private async refineWithOpenAI() {
    if (this.llmInFlight) return;
    if (!process.env.OPENAI_API_KEY) return;

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
    const result = await classifyByOpenAI(entry.input);
    if (!result || !entry.articleId) {
      // Give up after one failure — don't burn tokens retrying every cycle.
      entry.needsLLM = false;
      return;
    }
    entry.classification = result;
    entry.classifier = 'openai_nano';
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
          classifier: 'openai_nano',
          updated_at: new Date(),
        })
        .where('article_id', '=', entry.articleId)
        .execute();
    } catch (err) {
      console.error('[poller] failed to persist OpenAI classification:', err);
    }
  }

  private async persistCycle(
    session: TradingSession,
    rows: EnrichedRow[],
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
}

export const poller = new PollerService();

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

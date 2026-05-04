// PollerService — the singleton port of screener-poll_breakout.sh.
// One instance per API process. Holds cross-cycle state in memory.
// Single-instance only by design — see CLAUDE.md.

import { getDb } from '../db/index.js';
import type { RowStatus, ScreenerFilterSnapshot, NewsSource } from '../db/types.js';
import { fetchScreener, fetchFinvizNews, type ScreenerRow } from './finviz.js';
import { fetchYahooNews } from './yahoo.js';
import { fetchBenzingaDelta } from './benzinga.js';
import { broadcast } from './sse.js';

const DEFAULTS: ScreenerFilterSnapshot = {
  filter: 'ind_stocksonly,sh_float_u50,sh_price_1to25,sh_relvol_o5,ta_change_20to',
  float_max_m: 35,
  top_n: 50,
  accel_threshold: 2.0,
  interval_sec: 20,
};

const BZ_INITIAL_LOOKBACK_SEC = 1800;

export interface CyclePayload {
  cycle_id: string;
  polled_at: string;
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
}

export interface NewsHeadline {
  ticker: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: string | null;
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
  private bzWatermark = Math.floor(Date.now() / 1000) - BZ_INITIAL_LOOKBACK_SEC;
  private lastEtDate = '';

  // Last full payload, served by /api/screener/latest for new clients.
  private lastPayload: CyclePayload | null = null;

  status() {
    return {
      running: this.running,
      first_poll: this.firstPoll,
      tracked_tickers: this.prevChange.size,
      cached_headlines: this.bzHeadlineCache.size,
      bz_watermark: this.bzWatermark,
      config: this.config,
    };
  }

  setConfig(partial: Partial<ScreenerFilterSnapshot>) {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): ScreenerFilterSnapshot {
    return { ...this.config };
  }

  getLastPayload(): CyclePayload | null {
    return this.lastPayload;
  }

  start() {
    if (this.running) return;
    this.running = true;
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
    const todayEt = etDateString(new Date());
    if (todayEt !== this.lastEtDate) {
      this.bzHeadlineCache.clear();
      this.lastEtDate = todayEt;
    }

    // 1) screener
    const rows = await fetchScreener({
      filter: this.config.filter,
      floatMaxM: this.config.float_max_m,
      topN: this.config.top_n,
    });

    if (rows.length === 0) {
      console.log(`[poller] ${nowHms()} — no rows`);
      return;
    }

    const tickers = rows.map((r) => r.ticker);

    // 2) news — three sources in parallel
    const [finvizNews, yahooNews, bzDelta] = await Promise.all([
      fetchFinvizNews(tickers, todayEt).catch(() => []),
      fetchYahooNews(tickers, todayEt).catch(() => []),
      fetchBenzingaDelta(this.bzWatermark, todayEt).catch(() => null),
    ]);

    // Build per-cycle ticker → headline map with precedence Benzinga > Yahoo > Finviz.
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
    const freshTickers = bzDelta?.freshTickers ?? new Set<string>();
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

    // Apply persistent Benzinga cache as a base layer for tickers we've seen
    // before — even if they didn't return Finviz/Yahoo this cycle.
    for (const [tk, hl] of this.bzHeadlineCache) {
      if (!cycleNews.has(tk)) cycleNews.set(tk, hl);
    }

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
      };
    });

    // 4) update memory state for next cycle
    for (const r of rows) {
      if (r.change_pct != null) this.prevChange.set(r.ticker, r.change_pct);
    }

    // 5) persist
    const cycleId = await this.persistCycle(enriched, bzDelta?.articles, finvizNews, yahooNews);

    // 6) broadcast
    const newWithCatalyst = enriched
      .filter((r) => r.status === 'NEW' && r.has_today_news)
      .map((r) => r.ticker);
    const freshList = enriched.filter((r) => r.is_fresh_news).map((r) => r.ticker);

    const payload: CyclePayload = {
      cycle_id: cycleId,
      polled_at: new Date().toISOString(),
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
  }

  private async persistCycle(
    rows: EnrichedRow[],
    bzArticles: import('./benzinga.js').BenzingaArticle[] | undefined,
    finvizNews: Awaited<ReturnType<typeof fetchFinvizNews>>,
    yahooNews: Awaited<ReturnType<typeof fetchYahooNews>>,
  ): Promise<string> {
    const db = getDb();
    return db.transaction().execute(async (trx) => {
      const cycle = await trx
        .insertInto('screener_cycles')
        .values({
          filter_snapshot: JSON.stringify(this.config),
          row_count: rows.length,
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

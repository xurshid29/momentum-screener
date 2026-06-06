// On-demand per-ticker news fetch + store.
//
// The poller only ingests news for tickers currently in the screener universe
// (services/poller.ts builds `tickers` from the live screens). So a ticker that
// has dropped off the screens — but is still on a watchlist, or just clicked in
// Quote Details — stops accruing news in our DB even though Finviz/Yahoo have
// fresh items (the DBGI case: last screened 2026-05-27, so its 05-29+ news was
// never pulled). This module closes that gap: given a single ticker, it pulls
// its recent multi-day news live, upserts into news_articles + news_ticker_links
// (dedup by url, same shape as the poller's persist path), and rule-classifies
// each new article. Read endpoints call it best-effort before querying the DB,
// so clicking any ticker's news surfaces the last few days regardless of whether
// it's screening.
//
// Rate-bounded by a short per-ticker cache so repeated reads don't hammer
// Finviz. The fetch leaves the date filter off (todayEt='') → Finviz returns
// the recent multi-day window, which is exactly the swing-relevant horizon.

import { getDb } from '../db/index.js';
import { fetchFinvizNews } from './finviz.js';
import { fetchYahooNews } from './yahoo.js';
import { classifyByRules } from './catalyst-rules.js';
import type { NewsSource } from '../db/types.js';

// Per-ticker "freshly fetched" cache — skip the live fetch if we pulled this
// ticker within the window. Bounds Finviz/Yahoo calls under rapid clicking.
const FRESH_MS = 2 * 60 * 1000;
const lastFetched = new Map<string, number>();

// Finviz news dates are ET-local wall-clock, no tz ("YYYY-MM-DD HH:MM:SS").
// Assume EDT (-4); good enough for ordering/bucketing. Mirrors the poller's
// private parseEtNaiveAsDate.
function parseFinvizDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}-04:00`);
}

interface PendingArticle {
  source: NewsSource;
  url: string;
  title: string;
  published_at: Date | null;
  raw: unknown;
}

// Fetch + store the recent news for one ticker. Best-effort: any network/parse
// failure is swallowed (the caller still reads whatever's already in the DB).
// `force` bypasses the freshness cache (unused for now; reserved for a manual
// refresh button). Returns the number of newly-linked articles.
export async function fetchAndStoreTickerNews(ticker: string, force = false): Promise<number> {
  const t = ticker.toUpperCase();
  const now = Date.now();
  if (!force) {
    const last = lastFetched.get(t);
    if (last != null && now - last < FRESH_MS) return 0;
  }
  // Mark fetched up front so concurrent reads of the same ticker don't stampede.
  lastFetched.set(t, now);

  // Finviz with the date filter OFF → multi-day window. Yahoo per-ticker, also
  // unfiltered. Both already swallow their own errors and return [].
  const [finviz, yahoo] = await Promise.all([
    fetchFinvizNews([t], '').catch(() => []),
    fetchYahooNews([t], '').catch(() => []),
  ]);

  const pending: PendingArticle[] = [];
  for (const n of finviz) {
    // fetchFinvizNews splits aggregate articles across every tagged ticker; we
    // only want items actually tagged to this one.
    if (n.ticker !== t || !n.url) continue;
    pending.push({ source: 'finviz', url: n.url, title: n.title, published_at: parseFinvizDate(n.date), raw: n });
  }
  for (const n of yahoo) {
    if (!n.url) continue;
    pending.push({ source: 'yahoo', url: n.url, title: n.title, published_at: n.published_at, raw: n });
  }
  if (pending.length === 0) return 0;

  const db = getDb();
  let linked = 0;
  for (const p of pending) {
    try {
      const inserted = await db
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

      const isNew = inserted?.id != null;
      const articleId =
        inserted?.id ??
        (await db.selectFrom('news_articles').select('id').where('url', '=', p.url).executeTakeFirst())?.id;
      if (!articleId) continue;

      const linkRes = await db
        .insertInto('news_ticker_links')
        .values({ article_id: articleId, ticker: t })
        .onConflict((oc) => oc.columns(['article_id', 'ticker']).doNothing())
        .executeTakeFirst();
      if (Number(linkRes?.numInsertedOrUpdatedRows ?? 0) > 0) linked += 1;

      // Rule-classify newly-inserted articles so the catalyst badge/score is
      // populated without waiting for the (screener-only) LLM pass. Skip when
      // the article already existed — it's been classified before.
      if (isNew) {
        const cls = classifyByRules({ ticker: t, title: p.title, source: p.source });
        await db
          .insertInto('news_classifications')
          .values({
            article_id: articleId,
            impact_score: cls.impact_score,
            hype_score: cls.hype_score,
            direction: cls.direction,
            urgency: cls.urgency,
            catalyst_type: cls.catalyst_type,
            materiality: cls.materiality,
            confidence: cls.confidence,
            reason: cls.reason,
            risk_flags: JSON.stringify(cls.risk_flags) as unknown as never,
            classifier: 'rules',
          })
          .onConflict((oc) => oc.column('article_id').doNothing())
          .execute();
      }
    } catch {
      // One bad article shouldn't abort the rest.
      continue;
    }
  }
  return linked;
}

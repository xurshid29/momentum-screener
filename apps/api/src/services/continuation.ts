// Continuation candidates — tickers that have appeared in `ignition_results`
// on 2+ distinct ET trading days within the lookback window. Pure derivative
// of the persisted Ignition stream; no separate scan, no new state.
//
// The trade idea this surfaces: a name that keeps showing up day after day
// in the Ignition list isn't an intraday flicker — it's a multi-day move
// continuing across sessions, the kind of pattern the CODX, SBFM, FATN
// case studies in catching-runners.md all share. See web-dashboard.md
// "Continuation tab" for the full design.
//
// Cadence note: the aggregation joins ~5 days × 4320 cycles × ~25 ignition
// rows ≈ half a million rows in the window — ~1.5 s on prod. Too slow for
// every 20 s poll; the poller refreshes the cached list every ~10 min.

import { sql } from 'kysely';
import { getDb } from '../db/index.js';

const LOOKBACK_DAYS = 5;
const MIN_DAYS_SEEN = 2;
// Multi-day "the move is still alive" window. A Continuation row whose
// trigger was 3 days ago is still trade-relevant — wider than the live
// payload's "this cycle" / "today" news windows.
const NEWS_LOOKBACK_DAYS = 3;
const RESULT_LIMIT = 50;

export interface ContinuationCandidate {
  ticker: string;
  // Number of distinct ET trading days the ticker appeared in Ignition.
  days_seen: number;
  // First and last ET dates seen — bounds the active run.
  first_seen: string;     // YYYY-MM-DD
  last_seen: string;      // YYYY-MM-DD
  // Peak runner_score on the *first* day the ticker appeared. Low first_day
  // peak + climbing window peak = conviction growing; high then falling =
  // conviction fading.
  first_day_peak: number;
  // Peak runner_score in today's ET session — null when not in today's Ignition.
  today_peak: number | null;
  // Peak runner_score across the full lookback window.
  peak_window: number;
  // Price range across all sessions in the window.
  min_price: number;
  max_price: number;
  // Most recent news landing within NEWS_LOOKBACK_DAYS, joined with its
  // catalyst classification when one exists. catalyst_* fields are null
  // when the article hasn't been classified yet — the CatalystBadge then
  // renders the ✨ "pending" state.
  news_title: string | null;
  news_url: string | null;
  news_source: string | null;
  news_published_at: string | null;        // ISO-ish text
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  catalyst_reason: string | null;
}

// Pulls the active continuation candidates. `todayEt` is the current ET date
// in YYYY-MM-DD form (so the filter inside the SQL can identify "today's"
// rows without a second timezone conversion).
export async function getContinuationCandidates(todayEt: string): Promise<ContinuationCandidate[]> {
  const db = getDb();
  // Two-stage ignition rollup so the per-ticker stats see day-level peaks
  // rather than tick-level: a single big intraday score doesn't dominate,
  // and the "first day peak vs today peak" comparison is on the same
  // granularity. A separate `recent_news` CTE LEFT-JOINs each ticker to its
  // most recent article+classification within NEWS_LOOKBACK_DAYS.
  const result = await sql<{
    ticker: string;
    days_seen: number;
    first_seen: string;
    last_seen: string;
    first_day_peak: number;
    today_peak: number | null;
    peak_window: number;
    min_price: number;
    max_price: number;
    news_title: string | null;
    news_url: string | null;
    news_source: string | null;
    news_published_at: string | null;
    catalyst_score: number | null;
    catalyst_direction: string | null;
    catalyst_urgency: string | null;
    catalyst_type: string | null;
    catalyst_reason: string | null;
  }>`
    with recent as (
      select i.ticker, i.runner_score, i.price,
             (c.polled_at at time zone 'America/New_York')::date as et_date
      from ignition_results i
      join screener_cycles c on c.id = i.cycle_id
      where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
    ),
    per_day as (
      select ticker, et_date,
             max(runner_score)::float as day_peak_score,
             min(price)::float as day_min_px,
             max(price)::float as day_max_px
      from recent
      group by ticker, et_date
    ),
    ticker_summary as (
      select ticker,
             count(*)::int                                                  as days_seen,
             min(et_date)::text                                             as first_seen,
             max(et_date)::text                                             as last_seen,
             ((array_agg(day_peak_score order by et_date asc))[1])::float   as first_day_peak,
             (max(day_peak_score) filter (where et_date = ${todayEt}::date))::float as today_peak,
             max(day_peak_score)::float                                     as peak_window,
             min(day_min_px)::float                                         as min_price,
             max(day_max_px)::float                                         as max_price
      from per_day
      group by ticker
      having count(*) >= ${MIN_DAYS_SEEN}
    ),
    recent_news as (
      select distinct on (ntl.ticker)
             ntl.ticker,
             na.title,
             na.url,
             na.source::text         as source,
             na.published_at::text   as published_at,
             nc.impact_score::int    as catalyst_score,
             nc.direction::text      as catalyst_direction,
             nc.urgency::text        as catalyst_urgency,
             nc.catalyst_type        as catalyst_type,
             nc.reason               as catalyst_reason
      from news_ticker_links ntl
      join news_articles na on na.id = ntl.article_id
      left join news_classifications nc on nc.article_id = na.id
      where na.published_at > now() - (${NEWS_LOOKBACK_DAYS} || ' days')::interval
        and ntl.ticker in (select ticker from ticker_summary)
      order by ntl.ticker, na.published_at desc
    )
    -- days_seen ASC by design: fewer days = earlier in the move = the
    -- actionable entry. 5-6-day tickers are almost always already extended
    -- (CODX at day 5 was $7+, far past the entry); 2-3-day rows are the
    -- ones still forming. UI lets the user flip the sorter for the
    -- established-setups view.
    select ts.ticker, ts.days_seen, ts.first_seen, ts.last_seen,
           ts.first_day_peak, ts.today_peak, ts.peak_window,
           ts.min_price, ts.max_price,
           rn.title             as news_title,
           rn.url               as news_url,
           rn.source            as news_source,
           rn.published_at      as news_published_at,
           rn.catalyst_score,
           rn.catalyst_direction,
           rn.catalyst_urgency,
           rn.catalyst_type,
           rn.catalyst_reason
    from ticker_summary ts
    left join recent_news rn on rn.ticker = ts.ticker
    order by (ts.today_peak is not null) desc,
             ts.days_seen asc,
             ts.today_peak desc nulls last,
             ts.peak_window desc
    limit ${RESULT_LIMIT}
  `.execute(db);
  return result.rows.map((r) => ({
    ticker: r.ticker,
    days_seen: r.days_seen,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    first_day_peak: r.first_day_peak,
    today_peak: r.today_peak,
    peak_window: r.peak_window,
    min_price: r.min_price,
    max_price: r.max_price,
    news_title: r.news_title,
    news_url: r.news_url,
    news_source: r.news_source,
    news_published_at: r.news_published_at,
    catalyst_score: r.catalyst_score,
    catalyst_direction: r.catalyst_direction,
    catalyst_urgency: r.catalyst_urgency,
    catalyst_type: r.catalyst_type,
    catalyst_reason: r.catalyst_reason,
  }));
}

// Continuation candidates — names in the middle of a *multi-day* move, the
// CODX / SBFM / FATN pattern from docs/catching-runners.md.
//
// The model is "seed + forward-track", deliberately split so the strict
// real-time screen filters don't gate the very signal this is meant to catch:
//
//   • SEED   — a ticker that hit *either* the Momentum or the Ignition screen
//              on any day in the window. That's the "it did something" trigger.
//              (The old version seeded from Ignition only, so a Momentum-style
//              runner — bigger float, no nano-float volume burst — could never
//              appear here. Now both screens seed it.)
//
//   • TRACK  — each seed's subsequent days are read from `daily_bars`
//              (unfiltered EOD OHLCV), NOT from whether it re-qualified for a
//              screen. A name that gaps up day 2 but on calmer volume — below
//              the relvol/change gates — would never re-enter a screen, yet its
//              daily bar plainly shows the continuation. That bar-derived
//              "active day" is what keeps it on the list.
//
// A day counts as ACTIVE if the ticker hit a screen that day OR its daily bar
// shows a real move (close-to-close up ≥ ACTIVE_UP_PCT, or volume ≥
// ACTIVE_RVOL × its normal volume). days_in_run = distinct active days from the
// trigger onward; we require ≥ MIN_ACTIVE_DAYS (multi-day confirmed). A
// liveness gate then drops names that have round-tripped back toward their base
// (a dead pump isn't a continuation — see the survivorship note in
// catching-runners.md).
//
// Cost: the seed/screen rollup is a cached SQL aggregation (the poller refreshes
// it on a slow drumbeat). The forward-track reads `daily_bars`, which the
// DailyBarsService keeps fresh once-per-day-per-ticker off the hot path — so
// this whole feature adds ZERO live Finviz/3rd-party calls per cycle.

import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { dailyBars, getRecentBarsForTickers } from './daily-bars.js';
import { type DailyBar } from './finviz.js';

const LOOKBACK_DAYS = 7;
// Multi-day confirmation: a candidate needs the trigger day plus at least one
// follow-through active day (screen or bar-derived).
const MIN_ACTIVE_DAYS = 2;
// Bar-derived "active day" thresholds — deliberately looser than the screen
// filters (that's the whole point: catch the quiet day-2 grind the screens
// miss).
const ACTIVE_UP_PCT = 5;      // close-to-close up ≥ 5%
const ACTIVE_RVOL = 1.5;      // volume ≥ 1.5× the ticker's normal volume
// Liveness gate: keep a name only while its latest close holds at ≥ this
// fraction of the run's peak close. Below that it has faded/round-tripped and
// is no longer a live continuation.
const LIVENESS_MIN_FRAC = 0.5;
// Multi-day "the move is still alive" news window — wider than the live
// payload's "today" window so a catalyst from 2 days ago still surfaces.
const NEWS_LOOKBACK_DAYS = 3;
const RESULT_LIMIT = 50;
// How many bars to pull per seed — the window plus headroom to establish a
// "normal volume" baseline and the pre-trigger base close.
const BAR_FETCH_DAYS = LOOKBACK_DAYS + 40;

export interface ContinuationCandidate {
  ticker: string;
  // Distinct active days (screen OR bar-derived) from the trigger onward.
  days_in_run: number;
  // Of those, how many the ticker actually hit a screen — screen_days ≤
  // days_in_run; the gap is the days the daily bar carried the move alone.
  screen_days: number;
  first_seen: string;     // YYYY-MM-DD — trigger (first screen day in window)
  last_seen: string;      // YYYY-MM-DD — last screen day in window
  // Cumulative move from the run's base (close the day before the trigger) to
  // the latest close. null when daily bars aren't available yet.
  from_base_pct: number | null;
  // Latest close vs the run's peak close (≤ 0). Near 0 = holding the highs;
  // deeply negative = fading. Drives the liveness gate + the "Off peak" column.
  off_peak_pct: number | null;
  last_close: number | null;
  last_day_change_pct: number | null;   // most recent bar's close-to-close move
  // Peak Ignition runner_score in today's ET session; null when the ticker
  // isn't in today's Ignition list (incl. Momentum-only names). Kept as the
  // "is it hot right now" signal.
  today_peak: number | null;
  // Peak Ignition runner_score across the window; null for Momentum-only runs.
  peak_window_score: number | null;
  // Intraday price range observed while the ticker was active on a screen.
  min_price: number;
  max_price: number;
  // Most recent news within NEWS_LOOKBACK_DAYS + its catalyst classification.
  // catalyst_* are null until the article is classified (CatalystBadge → ✨).
  news_title: string | null;
  news_url: string | null;
  news_source: string | null;
  news_published_at: string | null;
  catalyst_score: number | null;
  catalyst_direction: string | null;
  catalyst_urgency: string | null;
  catalyst_type: string | null;
  catalyst_reason: string | null;
}

// Per-ticker screen-activity rollup straight out of SQL (the union of the
// Momentum + Ignition streams). The bar-derived fields are layered on in JS.
interface ScreenSummary {
  ticker: string;
  screen_days: number;
  first_seen: string;
  last_seen: string;
  screen_dates: string[];
  today_peak: number | null;
  peak_window_score: number | null;
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
}

// Pulls the active continuation candidates. `todayEt` is the current ET date in
// YYYY-MM-DD form so the SQL can flag "today's" rows without a second timezone
// conversion.
export async function getContinuationCandidates(todayEt: string): Promise<ContinuationCandidate[]> {
  const db = getDb();
  // ── Seed + screen rollup ──────────────────────────────────────────────
  // Union the two screens at day granularity (one row per ticker per ET day),
  // so a single big intraday tick doesn't dominate and Momentum/Ignition days
  // are weighted equally. runner_score only exists for Ignition rows, so it's
  // null for Momentum-only days.
  const summaryRows = await sql<ScreenSummary>`
    with ig as (
      select i.ticker,
             (c.polled_at at time zone 'America/New_York')::date as et_date,
             max(i.runner_score)::float as day_score,
             min(i.price)::float as day_min_px,
             max(i.price)::float as day_max_px
      from ignition_results i
      join screener_cycles c on c.id = i.cycle_id
      where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
      group by 1, 2
    ),
    mom as (
      select s.ticker,
             (c.polled_at at time zone 'America/New_York')::date as et_date,
             null::float as day_score,
             min(s.price)::float as day_min_px,
             max(s.price)::float as day_max_px
      from screener_results s
      join screener_cycles c on c.id = s.cycle_id
      where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
      group by 1, 2
    ),
    per_day as (
      select ticker, et_date,
             max(day_score) as day_score,
             min(day_min_px) as day_min_px,
             max(day_max_px) as day_max_px
      from (select * from ig union all select * from mom) u
      group by ticker, et_date
    ),
    summary as (
      select ticker,
             count(*)::int                                                       as screen_days,
             min(et_date)::text                                                  as first_seen,
             max(et_date)::text                                                  as last_seen,
             array_agg(et_date order by et_date asc)::text[]                      as screen_dates,
             max(day_score) filter (where et_date = ${todayEt}::date)            as today_peak,
             max(day_score)                                                      as peak_window_score,
             min(day_min_px)::float                                              as min_price,
             max(day_max_px)::float                                              as max_price
      from per_day
      group by ticker
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
        and ntl.ticker in (select ticker from summary)
      order by ntl.ticker, na.published_at desc
    )
    select s.ticker, s.screen_days, s.first_seen, s.last_seen, s.screen_dates,
           s.today_peak, s.peak_window_score, s.min_price, s.max_price,
           rn.title          as news_title,
           rn.url            as news_url,
           rn.source         as news_source,
           rn.published_at   as news_published_at,
           rn.catalyst_score,
           rn.catalyst_direction,
           rn.catalyst_urgency,
           rn.catalyst_type,
           rn.catalyst_reason
    from summary s
    left join recent_news rn on rn.ticker = s.ticker
  `.execute(db);

  const summaries = summaryRows.rows;
  if (summaries.length === 0) return [];

  // ── Forward-track via daily_bars ──────────────────────────────────────
  // Ensure every seed has daily-bar coverage for *next* refresh (idempotent,
  // rate-limited, off the hot path), then read whatever bars exist now.
  const seedTickers = summaries.map((s) => s.ticker);
  dailyBars.trackUniverse(seedTickers);
  const barsByTicker = await getRecentBarsForTickers(seedTickers, BAR_FETCH_DAYS);

  const candidates: ContinuationCandidate[] = [];
  for (const s of summaries) {
    const bars = barsByTicker.get(s.ticker) ?? [];
    const track = computeForwardTrack(bars, s.first_seen, todayEt, s.screen_dates);

    // Multi-day confirmation. With bars we use the richer active-day count;
    // without bars (not backfilled yet) we fall back to distinct screen days.
    const daysInRun = track ? track.daysInRun : s.screen_days;
    if (daysInRun < MIN_ACTIVE_DAYS) continue;

    // Liveness gate — only assessable when we have bars. No bars → keep
    // (degrade gracefully; the next refresh will have them).
    if (track && track.offPeakPct != null && track.offPeakPct < (LIVENESS_MIN_FRAC - 1) * 100) {
      continue;
    }

    candidates.push({
      ticker: s.ticker,
      days_in_run: daysInRun,
      screen_days: s.screen_days,
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      from_base_pct: track?.fromBasePct ?? null,
      off_peak_pct: track?.offPeakPct ?? null,
      last_close: track?.lastClose ?? null,
      last_day_change_pct: track?.lastDayChangePct ?? null,
      today_peak: s.today_peak,
      peak_window_score: s.peak_window_score,
      min_price: s.min_price,
      max_price: s.max_price,
      news_title: s.news_title,
      news_url: s.news_url,
      news_source: s.news_source,
      news_published_at: s.news_published_at,
      catalyst_score: s.catalyst_score,
      catalyst_direction: s.catalyst_direction,
      catalyst_urgency: s.catalyst_urgency,
      catalyst_type: s.catalyst_type,
      catalyst_reason: s.catalyst_reason,
    });
  }

  // Hot-today first, then earlier-stage runs (fewer days = closer to the entry;
  // late-stage rows are already extended), then biggest cumulative move.
  candidates.sort((a, b) => {
    const at = a.today_peak != null ? 1 : 0;
    const bt = b.today_peak != null ? 1 : 0;
    if (at !== bt) return bt - at;
    if (a.days_in_run !== b.days_in_run) return a.days_in_run - b.days_in_run;
    return (b.from_base_pct ?? 0) - (a.from_base_pct ?? 0);
  });
  return candidates.slice(0, RESULT_LIMIT);
}

interface ForwardTrack {
  daysInRun: number;
  fromBasePct: number | null;
  offPeakPct: number | null;
  lastClose: number | null;
  lastDayChangePct: number | null;
}

// Layer the unfiltered daily-bar view over the screen-day set: count active
// days from the trigger onward (screen day OR a real bar move), and measure how
// far the latest close sits above the run's base and below its peak.
function computeForwardTrack(
  bars: DailyBar[],
  firstSeen: string,
  todayEt: string,
  screenDates: string[],
): ForwardTrack | null {
  if (bars.length === 0) return null;

  // "Normal" volume baseline = mean volume of the bars *before* the window, so
  // the run's own elevated volume doesn't inflate its own baseline. Fall back
  // to the whole series when there's no pre-window history.
  const preWindow = bars.filter((b) => b.date < firstSeen);
  const volRef = preWindow.length >= 5 ? preWindow : bars;
  const avgVol = volRef.reduce((sum, b) => sum + b.volume, 0) / volRef.length || 0;

  // Base close = the close the day before the trigger (the launch pad). Fall
  // back to the earliest in-window bar's open-equivalent (its own close) when
  // there's no prior bar.
  const baseClose = preWindow.length > 0 ? preWindow[preWindow.length - 1].close : null;

  // Active days from the trigger onward. Screen days are active by definition;
  // bar days are active on a real close-to-close move or a volume surge.
  const activeDates = new Set<string>(screenDates.filter((d) => d >= firstSeen && d <= todayEt));
  let peakClose = 0;
  let lastClose: number | null = null;
  let lastDayChangePct: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.date < firstSeen || b.date > todayEt) continue;
    const prevClose = i > 0 ? bars[i - 1].close : null;
    const changePct = prevClose && prevClose > 0 ? ((b.close - prevClose) / prevClose) * 100 : null;
    const rvol = avgVol > 0 ? b.volume / avgVol : null;
    if ((changePct != null && changePct >= ACTIVE_UP_PCT) || (rvol != null && rvol >= ACTIVE_RVOL)) {
      activeDates.add(b.date);
    }
    if (b.close > peakClose) peakClose = b.close;
    lastClose = b.close;
    lastDayChangePct = changePct;
  }

  const fromBasePct =
    baseClose && baseClose > 0 && lastClose != null
      ? ((lastClose - baseClose) / baseClose) * 100
      : null;
  const offPeakPct =
    peakClose > 0 && lastClose != null ? ((lastClose - peakClose) / peakClose) * 100 : null;

  return {
    daysInRun: activeDates.size,
    fromBasePct,
    offPeakPct,
    lastClose,
    lastDayChangePct,
  };
}

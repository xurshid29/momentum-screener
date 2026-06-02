// OutcomesService — forward outcome tracking.
//
// Once per ET day (fired from the poller's post-close hook), roll the last N
// trading days of detections from each screen down to one row per
// (screen, ticker, ET date), capturing the entry context as it was at
// detection, then join daily_bars forward to record the close-to-close move
// over the next 1/3/5 trading days. Upsert + revisit: a name detected today
// gets chg_1d tomorrow, chg_3d in 3 days, chg_5d in 5, until bars_forward >= 5.
//
// Entry anchor is the detection-day daily_bars close — the honest reference for
// an overnight/multi-day hold. first/peak_change_pct keep the intraday context
// so "already-extended entries fade" stays directly testable.
//
// Adds ZERO live API calls in the request path: the forward join reads
// daily_bars (kept fresh by DailyBarsService), and we trackUniverse() the
// detected tickers so the nano-caps that never entered the Swing universe get
// backfilled for the *next* run. Outcomes stay null until their bars land.

import { sql } from 'kysely';
import { getDb } from '../db/index.js';
import { dailyBars } from './daily-bars.js';

// How many ET days back to (re)compute each run. Wide enough to fill the 5-day
// forward horizon for recent detections plus headroom for a missed run.
const LOOKBACK_DAYS = 12;

type Screen = 'momentum' | 'ignition' | 'swing';

class OutcomesService {
  private lastError: string | null = null;
  private lastRunAt = 0;
  private lastRowsUpserted = 0;

  status() {
    return {
      last_run_at: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      last_rows_upserted: this.lastRowsUpserted,
      last_error: this.lastError,
    };
  }

  // Compute outcomes for all three screens. Idempotent; safe to run repeatedly.
  async computeOutcomes(): Promise<number> {
    let total = 0;
    try {
      // Extend daily-bar coverage to every recently-detected ticker so the
      // forward join has data on subsequent runs (rate-limited, off hot path).
      await this.trackRecentTickers();
      for (const screen of ['momentum', 'ignition', 'swing'] as Screen[]) {
        total += await this.computeForScreen(screen);
      }
      this.lastRunAt = Date.now();
      this.lastRowsUpserted = total;
      this.lastError = null;
      console.log(`[outcomes] computed — ${total} rows upserted across 3 screens`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[outcomes] compute failed:', this.lastError);
    }
    return total;
  }

  // Queue every ticker detected in the lookback window for daily-bar coverage.
  private async trackRecentTickers(): Promise<void> {
    const db = getDb();
    const rows = await sql<{ ticker: string }>`
      select distinct ticker from (
        select s.ticker from screener_results s join screener_cycles c on c.id = s.cycle_id
          where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
        union
        select i.ticker from ignition_results i join screener_cycles c on c.id = i.cycle_id
          where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
        union
        select sw.ticker from swing_results sw join screener_cycles c on c.id = sw.cycle_id
          where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
      ) t
    `.execute(db);
    dailyBars.trackUniverse(rows.rows.map((r) => r.ticker));
  }

  // One upsert per screen. CTEs: `raw` rolls the per-cycle rows to one
  // entry-context row per (ticker, et_date); `day_cat` derives that day's best
  // catalyst from the news join (the source of catalyst direction/urgency/type
  // — only impact_score lives on the ignition/swing rows, and momentum rows
  // have no catalyst column at all); `entries` merges them; `anchor`/`fwd`/`agg`
  // join daily_bars forward off the entry-day close. Only `raw` is branched per
  // screen; everything downstream is shared.
  private async computeForScreen(screen: Screen): Promise<number> {
    const db = getDb();

    // Per-screen entry rollup. Each yields: ticker, et_date, entry_score,
    // first_change_pct, peak_change_pct, shelf_level, sessions. Catalyst fields
    // are joined separately (day_cat) since screener_results has no catalyst
    // column and the classified direction/urgency/type only live in the news
    // tables.
    const rawCte =
      screen === 'momentum'
        ? sql`
            raw as (
              select s.ticker,
                     (c.polled_at at time zone 'America/New_York')::date            as et_date,
                     null::numeric                                                   as entry_score,
                     (array_agg(s.change_pct order by c.polled_at asc))[1]::numeric  as first_change_pct,
                     max(s.change_pct)::numeric                                      as peak_change_pct,
                     null::text                                                      as shelf_level,
                     array_agg(distinct c.session)                                   as sessions
              from screener_results s
              join screener_cycles c on c.id = s.cycle_id
              where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
              group by 1, 2
            )`
        : screen === 'ignition'
          ? sql`
            raw as (
              select i.ticker,
                     (c.polled_at at time zone 'America/New_York')::date            as et_date,
                     max(i.runner_score)::numeric                                    as entry_score,
                     (array_agg(i.change_pct order by c.polled_at asc))[1]::numeric  as first_change_pct,
                     max(i.change_pct)::numeric                                      as peak_change_pct,
                     (array_agg(i.shelf_level order by c.polled_at desc) filter (where i.shelf_level is not null))[1] as shelf_level,
                     array_agg(distinct c.session)                                   as sessions
              from ignition_results i
              join screener_cycles c on c.id = i.cycle_id
              where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
              group by 1, 2
            )`
          : sql`
            raw as (
              select sw.ticker,
                     (c.polled_at at time zone 'America/New_York')::date            as et_date,
                     max(sw.swing_score)::numeric                                    as entry_score,
                     (array_agg(sw.change_pct order by c.polled_at asc))[1]::numeric as first_change_pct,
                     max(sw.change_pct)::numeric                                     as peak_change_pct,
                     (array_agg(sw.shelf_level order by c.polled_at desc) filter (where sw.shelf_level is not null))[1] as shelf_level,
                     array_agg(distinct c.session)                                   as sessions
              from swing_results sw
              join screener_cycles c on c.id = sw.cycle_id
              where c.polled_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
              group by 1, 2
            )`;

    const res = await sql`
      with ${rawCte},
      -- That day's most-impactful catalyst per ticker, from the news join. We
      -- bucket each article to its ET publish date and pick the highest
      -- impact_score per (ticker, date). DISTINCT ON keeps the winner's full
      -- classification row (direction/urgency/type) together.
      day_cat as (
        select distinct on (ntl.ticker, (na.published_at at time zone 'America/New_York')::date)
               ntl.ticker,
               (na.published_at at time zone 'America/New_York')::date as et_date,
               nc.impact_score::int as catalyst_score,
               nc.direction::text   as catalyst_direction,
               nc.urgency::text     as catalyst_urgency,
               nc.catalyst_type     as catalyst_type
        from news_ticker_links ntl
        join news_articles na on na.id = ntl.article_id
        join news_classifications nc on nc.article_id = na.id
        where na.published_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
          and ntl.ticker in (select ticker from raw)
        order by ntl.ticker, (na.published_at at time zone 'America/New_York')::date, nc.impact_score desc
      ),
      entries as (
        select r.ticker, r.et_date, r.entry_score, r.first_change_pct, r.peak_change_pct,
               r.shelf_level, r.sessions,
               dc.catalyst_score, dc.catalyst_direction, dc.catalyst_urgency, dc.catalyst_type
        from raw r
        left join day_cat dc on dc.ticker = r.ticker and dc.et_date = r.et_date
      ),
      -- Entry-day close (the anchor) + the next session's open, from daily_bars.
      anchor as (
        select e.*,
               eb.close::numeric                                              as entry_close,
               (select db2.open from daily_bars db2
                  where db2.ticker = e.ticker and db2.date > e.et_date
                  order by db2.date asc limit 1)::numeric                     as next_open
        from entries e
        left join daily_bars eb on eb.ticker = e.ticker and eb.date = e.et_date
      ),
      -- Forward bars: the up-to-5 trading days strictly after et_date.
      fwd as (
        select a.ticker, a.et_date,
               b.date, b.close, b.high, b.low,
               row_number() over (partition by a.ticker, a.et_date order by b.date asc) as fwd_n
        from anchor a
        join daily_bars b on b.ticker = a.ticker and b.date > a.et_date and b.date <= a.et_date + 10
        where a.entry_close is not null and a.entry_close > 0
      ),
      agg as (
        select ticker, et_date,
               count(*) filter (where fwd_n <= 5)                          as bars_forward,
               max(close) filter (where fwd_n = 1)                         as c1,
               max(close) filter (where fwd_n = 3)                         as c3,
               max(close) filter (where fwd_n = 5)                         as c5,
               max(high)  filter (where fwd_n <= 5)                        as hi5,
               min(low)   filter (where fwd_n <= 5)                        as lo5
        from fwd group by ticker, et_date
      )
      insert into screener_outcomes (
        screen, ticker, et_date, entry_close, next_open, entry_score,
        first_change_pct, peak_change_pct, catalyst_score, catalyst_direction,
        catalyst_urgency, catalyst_type, shelf_level, sessions,
        chg_1d, chg_3d, chg_5d, peak_5d, drawdown_5d, bars_forward
      )
      select ${screen}, a.ticker, a.et_date, a.entry_close, a.next_open, a.entry_score,
             a.first_change_pct, a.peak_change_pct, a.catalyst_score, a.catalyst_direction,
             a.catalyst_urgency, a.catalyst_type, a.shelf_level, a.sessions,
             case when ag.c1 is not null and a.entry_close > 0 then round(((ag.c1 - a.entry_close) / a.entry_close * 100)::numeric, 2) end,
             case when ag.c3 is not null and a.entry_close > 0 then round(((ag.c3 - a.entry_close) / a.entry_close * 100)::numeric, 2) end,
             case when ag.c5 is not null and a.entry_close > 0 then round(((ag.c5 - a.entry_close) / a.entry_close * 100)::numeric, 2) end,
             case when ag.hi5 is not null and a.entry_close > 0 then round(((ag.hi5 - a.entry_close) / a.entry_close * 100)::numeric, 2) end,
             case when ag.lo5 is not null and a.entry_close > 0 then round(((ag.lo5 - a.entry_close) / a.entry_close * 100)::numeric, 2) end,
             coalesce(ag.bars_forward, 0)
      from anchor a
      left join agg ag on ag.ticker = a.ticker and ag.et_date = a.et_date
      on conflict (screen, ticker, et_date) do update set
        entry_close        = excluded.entry_close,
        next_open          = excluded.next_open,
        entry_score        = excluded.entry_score,
        first_change_pct   = excluded.first_change_pct,
        peak_change_pct    = excluded.peak_change_pct,
        catalyst_score     = excluded.catalyst_score,
        catalyst_direction = excluded.catalyst_direction,
        catalyst_urgency   = excluded.catalyst_urgency,
        catalyst_type      = excluded.catalyst_type,
        shelf_level        = excluded.shelf_level,
        sessions           = excluded.sessions,
        chg_1d             = excluded.chg_1d,
        chg_3d             = excluded.chg_3d,
        chg_5d             = excluded.chg_5d,
        peak_5d            = excluded.peak_5d,
        drawdown_5d        = excluded.drawdown_5d,
        bars_forward       = excluded.bars_forward,
        updated_at         = current_timestamp
    `.execute(db);

    return Number(res.numAffectedRows ?? 0n);
  }
}

export const outcomes = new OutcomesService();

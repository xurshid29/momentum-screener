// ↑ VWAP reclaim tracker — the operator's observation (2026-08-21): "too
// often, when a ticker crosses the VWAP it rallies up". This is the session-
// VWAP version of that on the live per-second feed, decided on CLOSED 1-minute
// candles (TV parity with the operator's 1m workflow: "wait for the close").
//
// Pure + stateful-per-symbol, like TickDetector: feed it per-second bars in
// time order, it returns the transitions that fire on that bar:
//
//   idle ──reclaim──▶ reclaimed ──confirm──▶ confirmed
//                         │                      │
//                       lost / expire          lost
//
// • VWAP = Σ(HLC3 × vol) / Σ vol since the 04:00 ET session open, same
//   construction as Edge / TradingView's Session VWAP on an extended-hours
//   chart. Feed-visible (EQUS.MINI) volume, so levels can sit a little off the
//   consolidated chart on thin names — the chart is the execution reference.
// • RECLAIM fires when a 1m candle closes above VWAP (+ a small buffer) after
//   the name spent ≥ below_bars_min closed candles BELOW it — a real pullback
//   under VWAP and back, not a flicker around the line. The reclaim bar must
//   clear a junk floor (prints + feed-visible $) and the symbol needs
//   min_history_sec of tape behind its VWAP so a just-subscribed anchor can't
//   fire off three bars of data.
// • CONFIRM ("started moving up") fires on a closed candle that either HOLDS
//   above VWAP with a close ≥ the reclaim close (via 'hold'), or EXTENDS to
//   ≥ confirm_ext_pct above VWAP (via 'extend' — also allowed on the reclaim
//   bar itself for a vertical cross). An unconfirmed reclaim EXPIRES after
//   confirm_ttl_sec.
// • LOST fires when a candle closes under VWAP by lost_buffer_pct — that is
//   the exit/“fade” signal the operator asked to think about; the event
//   carries minutes held and the peak % above VWAP so grading can say what a
//   typical hold is worth and how long it lasts.
//
// Anchor honesty: a symbol subscribed mid-session (screen-sync) or a service
// that booted mid-session has no bars back to 04:00, so its VWAP is anchored
// at the first bar we saw. Events carry anchor = 'session' | 'partial' so the
// grading pass can split the two; a partial anchor is the poller's Finviz
// VWAP's limitation too. A Databento 1m warmup (the Edge approach) is the
// upgrade path if partial reclaims grade worse.

export const VWAP_RECLAIM = {
  bar_sec: 60,
  below_bars_min: 5,        // closed 1m candles under VWAP before a cross counts
  reclaim_buffer_pct: 0.2,  // close must clear VWAP by this much
  lost_buffer_pct: 0.3,     // close this far under VWAP = lost (hysteresis vs reclaim)
  confirm_ext_pct: 1.0,     // a close ≥ VWAP × (1 + this) confirms on its own
  confirm_ttl_sec: 600,     // unconfirmed reclaim expires after 10 min
  min_history_sec: 20 * 60, // tape behind the VWAP before the first reclaim may fire
  session_anchor_grace_sec: 15 * 60, // first bar within this of 04:00 ET (or boot) still counts as a session anchor
  floor_prints: 3,          // reclaim bar: ≥ traded seconds…
  floor_notional: 2000,     // …and ≥ feed-visible $ (same scale as the 👀 watch floor)
  max_episodes_day: 4,      // per symbol per session — after that, display-only noise
  vol_ratio_lookback: 10,   // closed bars for the reclaim-bar volume ratio (telemetry)
  late_subs_ttl_ms: 30 * 3600_000, // markLate entries self-clean after this
} as const;

export interface VwapBar {
  ts_sec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type VwapEventType = 'reclaim' | 'confirm' | 'lost' | 'expire';
export type VwapAnchor = 'session' | 'partial';

export interface VwapEvent {
  type: VwapEventType;
  ticker: string;
  ts_sec: number;           // close ts of the candle that tripped the transition
  price: number;            // that candle's close
  vwap: number;
  pct_vs_vwap: number;      // (price / vwap − 1) × 100
  anchor: VwapAnchor;
  anchor_ts: number;        // first bar folded into this session's VWAP
  episode: number;          // 1-based per symbol per session
  // reclaim context (on every event of the episode)
  reclaim_price: number;
  reclaim_ts: number;
  below_bars: number;       // closed candles under VWAP before the reclaim
  vol_ratio: number | null; // reclaim-bar volume / median of the prior closed bars
  notional: number;         // feed-visible $ on the reclaim bar
  // confirm provenance
  via?: 'hold' | 'extend';
  // lost/expire telemetry
  minutes?: number;         // since the reclaim
  peak_pct?: number;        // max close % above VWAP during the episode
}

export interface VwapSnapshot {
  price: number;
  vwap: number;
  pct_vs_vwap: number;
  ts_sec: number;
}

type Phase = 'idle' | 'reclaimed' | 'confirmed';

interface Bucket {
  bucket: number;
  open: number; high: number; low: number; close: number;
  volume: number; prints: number; notional: number;
}

interface SymbolState {
  sessionKey: string;
  anchorTs: number;
  anchor: VwapAnchor;
  pxVol: number;
  vol: number;
  cur: Bucket | null;
  lastClose: number;         // latest 1s close (live snapshot)
  lastTs: number;
  belowCount: number;        // consecutive closed candles under VWAP
  phase: Phase;
  reclaim: { ts: number; price: number; vwap: number; belowBars: number; volRatio: number | null; notional: number } | null;
  peakPct: number;
  episodes: number;
  recentVols: number[];      // closed-bar volumes, for vol_ratio
}

const etDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const etClockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// Session key — the ET date of the 04:00-anchored session (00:00–03:59 ET
// belongs to the previous session), same rule as edge-tracker.
export function vwapSessionKey(tsSec: number): string {
  return etDateFmt.format(new Date(tsSec * 1000 - 4 * 3600_000));
}

// Epoch seconds of the 04:00 ET session open that `tsSec` belongs to.
export function vwapSessionOpenSec(tsSec: number): number {
  const parts = etClockFmt.formatToParts(new Date(tsSec * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const h = get('hour'), m = get('minute'), s = get('second');
  const sinceOpen = (((h - 4) + 24) % 24) * 3600 + m * 60 + s;
  return tsSec - sinceOpen;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class VwapReclaimTracker {
  private state = new Map<string, SymbolState>();
  // Symbols subscribed mid-session → their VWAP anchor is partial for that
  // session. Keyed by session so a late sub carries into the next session
  // as a full anchor. Value = markLate wall-clock ms for self-cleaning.
  private lateSubs = new Map<string, { sessionKey: string; at: number }>();
  // When this tracker started observing (epoch sec). A boot after the session
  // open means every symbol's VWAP is partial for that session.
  private startedAt: number;

  constructor(nowSec = Math.floor(Date.now() / 1000)) {
    this.startedAt = nowSec;
  }

  markLate(ticker: string, nowSec = Math.floor(Date.now() / 1000)): void {
    const t = ticker.toUpperCase();
    // Only matters if the symbol has no state yet this session — a symbol
    // already accumulating keeps its anchor.
    const st = this.state.get(t);
    const key = vwapSessionKey(nowSec);
    if (st && st.sessionKey === key) return;
    this.lateSubs.set(t, { sessionKey: key, at: nowSec * 1000 });
    if (this.lateSubs.size > 2000) {
      const cutoff = nowSec * 1000 - VWAP_RECLAIM.late_subs_ttl_ms;
      for (const [k, v] of this.lateSubs) if (v.at < cutoff) this.lateSubs.delete(k);
    }
  }

  symbolsTracked(): number {
    return this.state.size;
  }

  snapshot(ticker: string): VwapSnapshot | null {
    const st = this.state.get(ticker.toUpperCase());
    if (!st || st.vol <= 0 || !(st.lastClose > 0)) return null;
    const vwap = st.pxVol / st.vol;
    return { price: st.lastClose, vwap, pct_vs_vwap: (st.lastClose / vwap - 1) * 100, ts_sec: st.lastTs };
  }

  // Drop per-session state (the midnight-ET sidecar respawn). VWAP itself
  // rolls on the 04:00 session key inside addBar, so this is just hygiene.
  reset(): void {
    this.state.clear();
  }

  // Feed one per-second bar in time order. Returns the transitions tripped by
  // this bar (usually none; a vertical cross can return reclaim + confirm).
  addBar(tickerRaw: string, bar: VwapBar): VwapEvent[] {
    if (!(bar.close > 0) || !Number.isFinite(bar.ts_sec)) return [];
    const ticker = tickerRaw.toUpperCase();
    const key = vwapSessionKey(bar.ts_sec);
    let st = this.state.get(ticker);
    const out: VwapEvent[] = [];

    if (!st || st.sessionKey !== key) {
      // New session for this symbol. A still-open episode from the previous
      // session is simply dropped — VWAP resets at 04:00 ET and so does the
      // playbook (the poller's display TTLs already retired the row).
      const open = vwapSessionOpenSec(bar.ts_sec);
      const late = this.lateSubs.get(ticker);
      const lateThisSession = late?.sessionKey === key;
      const bootedMidSession = this.startedAt > open + VWAP_RECLAIM.session_anchor_grace_sec;
      st = {
        sessionKey: key,
        anchorTs: bar.ts_sec,
        anchor: lateThisSession || bootedMidSession ? 'partial' : 'session',
        pxVol: 0, vol: 0, cur: null,
        lastClose: bar.close, lastTs: bar.ts_sec,
        belowCount: 0, phase: 'idle', reclaim: null, peakPct: 0, episodes: 0, recentVols: [],
      };
      this.state.set(ticker, st);
      if (late && !lateThisSession) this.lateSubs.delete(ticker);
    }

    if (bar.ts_sec < st.lastTs) return []; // out-of-order — ignore, like the other trackers

    // Session VWAP on the raw 1s bars (HLC3 × volume).
    const v = Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    const hi = bar.high > 0 ? bar.high : bar.close;
    const lo = bar.low > 0 ? bar.low : bar.close;
    st.pxVol += ((hi + lo + bar.close) / 3) * v;
    st.vol += v;
    st.lastClose = bar.close;
    st.lastTs = bar.ts_sec;

    // 1m bucket — causal: a candle closes when a trade lands in a later one.
    const b = Math.floor(bar.ts_sec / VWAP_RECLAIM.bar_sec) * VWAP_RECLAIM.bar_sec;
    if (!st.cur) {
      st.cur = { bucket: b, open: bar.open, high: hi, low: lo, close: bar.close, volume: v, prints: 1, notional: bar.close * v };
      return out;
    }
    if (b === st.cur.bucket) {
      if (hi > st.cur.high) st.cur.high = hi;
      if (lo < st.cur.low) st.cur.low = lo;
      st.cur.close = bar.close;
      st.cur.volume += v;
      st.cur.prints += 1;
      st.cur.notional += bar.close * v;
      return out;
    }
    if (b < st.cur.bucket) return out;

    // Close the previous candle against the VWAP as of its close. The
    // accumulator already includes this first bar of the NEXT candle — a
    // one-second skew, immaterial next to the feed-visibility caveat, and it
    // keeps the code single-pass.
    const closed = st.cur;
    st.cur = { bucket: b, open: bar.open, high: hi, low: lo, close: bar.close, volume: v, prints: 1, notional: bar.close * v };
    if (st.vol <= 0) return out;
    const vwap = st.pxVol / st.vol;
    const closeTs = closed.bucket + VWAP_RECLAIM.bar_sec;
    this.onClosedCandle(ticker, st, closed, closeTs, vwap, out);
    return out;
  }

  private onClosedCandle(ticker: string, st: SymbolState, c: Bucket, closeTs: number, vwap: number, out: VwapEvent[]): void {
    const pct = (c.close / vwap - 1) * 100;
    const above = pct >= VWAP_RECLAIM.reclaim_buffer_pct;
    const lostLine = pct <= -VWAP_RECLAIM.lost_buffer_pct;
    const volRatio = (() => {
      const base = median(st.recentVols);
      return base > 0 ? +(c.volume / base).toFixed(2) : null;
    })();
    st.recentVols.push(c.volume);
    if (st.recentVols.length > VWAP_RECLAIM.vol_ratio_lookback) st.recentVols.shift();

    const base = (type: VwapEventType): VwapEvent => ({
      type, ticker, ts_sec: closeTs, price: c.close, vwap: +vwap.toFixed(4), pct_vs_vwap: +pct.toFixed(2),
      anchor: st.anchor, anchor_ts: st.anchorTs, episode: st.episodes,
      reclaim_price: st.reclaim?.price ?? c.close, reclaim_ts: st.reclaim?.ts ?? closeTs,
      below_bars: st.reclaim?.belowBars ?? st.belowCount,
      vol_ratio: st.reclaim?.volRatio ?? volRatio, notional: st.reclaim?.notional ?? c.notional,
    });
    const endEpisode = (type: 'lost' | 'expire') => {
      const ev = base(type);
      ev.minutes = st.reclaim ? Math.round((closeTs - st.reclaim.ts) / 60) : 0;
      ev.peak_pct = +st.peakPct.toFixed(2);
      out.push(ev);
      st.phase = 'idle';
      st.reclaim = null;
      st.peakPct = 0;
    };

    if (st.phase === 'idle') {
      if (c.close < vwap) {
        st.belowCount += 1;
        return;
      }
      // At VWAP or inside the buffer band — neither a bar below nor a clean
      // reclaim; the below-count is kept, not reset.
      if (!above) return;
      const belowBars = st.belowCount;
      st.belowCount = 0;
      if (belowBars < VWAP_RECLAIM.below_bars_min) return;
      if (closeTs - st.anchorTs < VWAP_RECLAIM.min_history_sec) return;
      if (c.prints < VWAP_RECLAIM.floor_prints || c.notional < VWAP_RECLAIM.floor_notional) return;
      if (st.episodes >= VWAP_RECLAIM.max_episodes_day) return;
      st.episodes += 1;
      st.reclaim = { ts: closeTs, price: c.close, vwap, belowBars, volRatio, notional: c.notional };
      st.phase = 'reclaimed';
      st.peakPct = pct;
      out.push(base('reclaim'));
      if (pct >= VWAP_RECLAIM.confirm_ext_pct) {
        st.phase = 'confirmed';
        out.push({ ...base('confirm'), via: 'extend' });
      }
      return;
    }

    // reclaimed / confirmed — track the peak, watch for the loss.
    if (pct > st.peakPct) st.peakPct = pct;
    if (lostLine) {
      endEpisode('lost');
      st.belowCount = 1;
      return;
    }
    if (st.phase === 'reclaimed' && st.reclaim) {
      if (pct >= VWAP_RECLAIM.confirm_ext_pct) {
        st.phase = 'confirmed';
        out.push({ ...base('confirm'), via: 'extend' });
      } else if (c.close > vwap && c.close >= st.reclaim.price) {
        st.phase = 'confirmed';
        out.push({ ...base('confirm'), via: 'hold' });
      } else if (closeTs - st.reclaim.ts >= VWAP_RECLAIM.confirm_ttl_sec) {
        endEpisode('expire');
        if (c.close < vwap) st.belowCount = 1;
      }
    }
  }
}

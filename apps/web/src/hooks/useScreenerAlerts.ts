import { useEffect, useRef } from 'react';
import { useAlertsArmed } from './useAlertsArmed';
import type { CyclePayload } from '../api/types';

// Browser equivalent of the bash script's audio + voice alerts. Events:
// • Tick WATCH (👀) — soft single ping, price-led early flag from the tick feed
// • Tick CONFIRMED (🛰️) — radar ping, the volume-confirmed tier
// • NEW + catalyst — distinct double-tone (fires even on first poll)
// • FRESH news (Benzinga delta) — single chime (suppressed on first cached payload)
// We dedupe per cycle_id to survive accidental SSE re-deliveries, and track
// already-seen (ticker, tier) pairs so a catch (which persists ~15 min) pings
// once per tier — a real runner gives exactly two pings: flag, then confirm.

// Dashboard alert kill switches — mirrors the server-side ALERTS_DISABLED.
// 2026-07-22: everything muted except EMA-cross confirmations (operator's
// call). 2026-08-21: EMA is parked and the operator asked for alerts when a
// new Live Tick appears — 🛰️ CONFIRMED only (the 👀 watch heads-up was
// switched back off the same morning: too early a tier to act on), plus the
// new ↑ VWAP reclaim list (soft tone on reclaim, bright pair on confirm).
// Disabled, not
// deleted: the seen-set bookkeeping below keeps marking events while muted,
// so flipping a flag back on never back-blasts the day's backlog.
const DASHBOARD_ALERTS: Record<
  'ema_cross_confirm' | 'ema_cross_observe' | 'news_radar' | 'tick_confirmed' | 'tick_watch' | 'accum' | 'new_with_catalyst' | 'fresh_news'
  | 'vwap_reclaimed' | 'vwap_confirmed',
  boolean
> = {
  ema_cross_confirm: true,  // ✅ volume confirmed — bright two-tone + notification
  ema_cross_observe: true,  // 📈 new cross appeared — soft single tone
  news_radar: false,
  tick_confirmed: true,     // 🛰️ radar ping + notification (2026-08-21)
  tick_watch: false,        // 👀 off again (2026-08-21 pm) — confirmed-only, operator's call
  accum: false,
  vwap_reclaimed: false,    // ↑ layer parked 2026-08-22 (COMPONENTS_DISABLED vwap) — graded as noise
  vwap_confirmed: false,
  new_with_catalyst: false,
  fresh_news: false,
};

// Master gate for every sound + notification, mirrored from the Alerts
// ON/OFF button (2026-07-31). Enforced inside beep()/notify() rather than at
// the ~12 call sites: everything audible routes through those two, so a new
// alert type can never accidentally bypass the mute. Starts false so a reload
// before the hook syncs is silent rather than surprising.
let armedGate = false;

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return audioCtx;
}

// Trader-friendly alert tone: sharp attack, ~70% sustain, brief decay.
// Layers a sine + a triangle one octave higher for more presence than a
// pure sine — cuts through background noise without being harsh.
function beep(frequency: number, durationMs: number, when = 0, peak = 0.55) {
  if (!armedGate) return;
  const ac = ctx();
  const t0 = ac.currentTime + when;
  const dur = durationMs / 1000;
  const sustainEnd = t0 + dur * 0.7;
  const end = t0 + dur;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
  gain.gain.setValueAtTime(peak, sustainEnd);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  gain.connect(ac.destination);

  const fundamental = ac.createOscillator();
  fundamental.type = 'sine';
  fundamental.frequency.value = frequency;
  fundamental.connect(gain);
  fundamental.start(t0);
  fundamental.stop(end + 0.05);

  // Octave-up harmonic at lower amplitude — gives the tone a brighter,
  // more "alert" character without distorting.
  const harmonic = ac.createOscillator();
  const harmonicGain = ac.createGain();
  harmonic.type = 'triangle';
  harmonic.frequency.value = frequency * 2;
  harmonicGain.gain.value = 0.35;
  harmonic.connect(harmonicGain).connect(gain);
  harmonic.start(t0);
  harmonic.stop(end + 0.05);
}

function dingDing() {
  // 3 ascending tones — major catalyst, deserves a triple ding.
  beep(880, 220);          // A5
  beep(1320, 220, 0.24);   // E6
  beep(1760, 280, 0.48);   // A6
}

function chime() {
  // 2 ascending tones for fresh news.
  beep(660, 220);          // E5
  beep(880, 240, 0.24);    // A5
}

function radarPing() {
  // Distinctive 2-tone "satellite" ping for a CONFIRMED tick catch (🛰️) — sits
  // above the catalyst/news tones so it's recognisable as the early signal.
  beep(1245, 150, 0, 0.5);     // D#6
  beep(1660, 200, 0.15, 0.5);  // G#6
}

function watchPing() {
  // Single soft tone for a tick WATCH (👀) — the price-led early flag. Quieter
  // and lower than the confirm radar ping: a heads-up, not a conviction call.
  beep(990, 180, 0, 0.35);     // B5
}

function newsRadarPing() {
  // Two soft low tones for a NEWS RADAR hit (📰) — a fresh catalyst on a known
  // runner that isn't moving yet. Lower than everything else: informational,
  // "glance when you can", not "look NOW".
  beep(587, 160, 0, 0.32);     // D5
  beep(740, 200, 0.18, 0.32);  // F#5
}

function accumPing() {
  // Single hushed tone for quiet accumulation (🤫) — volume arriving while
  // price is still flat. The quietest ping in the set, by design.
  beep(523, 200, 0, 0.28);     // C5
}

function crossObservePing() {
  // 📈 a new EMA cross appeared (observing) — single soft mid tone. A
  // heads-up to glance at the chart; deliberately quieter than the confirm.
  beep(659, 220, 0, 0.34);     // E5
}

function crossConfirmPing() {
  // 📈✅ volume confirmed the cross — bright ascending pair, THE alert sound
  // of the dashboard now that everything else is muted (2026-07-22).
  beep(988, 170, 0, 0.5);      // B5
  beep(1480, 240, 0.18, 0.5);  // F#6
}

export function edgeAlertPing(kind: 'armed' | 'entry' | 'bailout') {
  if (kind === 'armed') {
    // Soft preparation cue: the chart has reached a decision zone.
    beep(740, 170, 0, 0.32);
    return;
  }
  if (kind === 'entry') {
    // Bright ascending confirmation — completed 1m candle + MACD turn.
    beep(988, 160, 0, 0.52);
    beep(1568, 240, 0.17, 0.52);
    return;
  }
  // Descending loss-of-level cue. It must be unmistakable but brief.
  beep(784, 170, 0, 0.5);
  beep(392, 280, 0.16, 0.55);
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

function notify(title: string, body: string) {
  if (!armedGate) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/vite.svg', tag: title });
    } catch {
      // some browsers throw if called outside a user gesture; ignore
    }
  }
}

export function notifyEdge(title: string, body: string) {
  notify(title, body);
}

export function useScreenerAlerts(payload: CyclePayload | null) {
  // The Alerts ON/OFF button is a real mute (2026-07-31). It used to be
  // cosmetic: nothing read its state, so confirmations beeped with alerts
  // "OFF". Bookkeeping below still runs while muted — the seen-sets keep
  // marking events — so re-arming never back-blasts the day's backlog, the
  // same principle as the server-side ALERTS_DISABLED.
  const armed = useAlertsArmed();
  // Mirror into the module gate during render so it is already correct when
  // the payload effect below runs (effects fire after render, and a stale
  // gate would leak exactly one beep on the cycle the user hits mute).
  armedGate = armed;
  // Track cycle ids we've already handled so SSE replay (e.g. on reconnect) doesn't double-fire.
  const handled = useRef<Set<string>>(new Set());
  // Skip the very first payload (which is the cached snapshot the server pushes
  // immediately on subscribe — not a real new cycle).
  const seenFirst = useRef(false);
  // Tick catches persist ~15 min (many payloads); track (ticker, tier) keys
  // we've already pinged so each catch alerts once per tier, not every cycle.
  const seenTicks = useRef<Set<string>>(new Set());
  // News-radar entries persist ~90 min; ping each article once.
  const seenRadar = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    const tickKeys = (payload.tick_catches ?? [])
      .filter((t) => t.status !== 'faded')
      .map((t) => ({ key: `${t.ticker}:${t.status ?? 'confirmed'}`, ticker: t.ticker, status: t.status ?? 'confirmed' }));
    const radarKeys = (payload.news_radar ?? [])
      .map((n) => ({ key: `${n.ticker}:${n.url}`, ticker: n.ticker }));
    // EMA-cross layer: two distinct sounds — a soft tone when a NEW cross
    // appears (observing; the nomination itself is the operator's cue on the
    // HTF layers) and a bright pair when volume CONFIRMS.
    const crossConfirmKeys = (payload.ema_crosses ?? [])
      .filter((x) => x.status === 'confirmed')
      .map((x) => ({ key: `${x.tf}|${x.signal}|${x.ticker}:${x.confirmed_at}`, ticker: x.ticker }));
    const crossObserveKeys = (payload.ema_crosses ?? [])
      .map((x) => ({ key: `${x.tf}|${x.signal}|${x.ticker}:${x.cross_at}`, ticker: x.ticker, confirmed: x.status === 'confirmed' }));

    if (!seenFirst.current) {
      seenFirst.current = true;
      // Seed seen ticks so catches already on screen at load don't all ping.
      tickKeys.forEach((t) => seenTicks.current.add(t.key));
      radarKeys.forEach((n) => seenRadar.current.add(n.key));
      crossConfirmKeys.forEach((x) => seenTicks.current.add(x.key));
      crossObserveKeys.forEach((x) => seenTicks.current.add(x.key));
      (payload.vwap_reclaims ?? []).forEach((v) => seenTicks.current.add(`${v.ticker}:vwap:${v.reclaim_at}:${v.status}`));
      return;
    }

    const newConfirmedCrosses = crossConfirmKeys.filter((x) => !seenTicks.current.has(x.key));
    newConfirmedCrosses.forEach((x) => seenTicks.current.add(x.key));
    // A row that arrives already confirmed (instant confirm) only plays the
    // confirm sound — mark its cross key as seen without the observe tone.
    const newObserving = crossObserveKeys.filter((x) => !seenTicks.current.has(x.key));
    newObserving.forEach((x) => seenTicks.current.add(x.key));
    const newObservingOnly = newObserving.filter((x) => !x.confirmed);

    if (DASHBOARD_ALERTS.ema_cross_confirm && newConfirmedCrosses.length > 0) {
      try { crossConfirmPing(); } catch { /* audio context not unlocked */ }
      notify(
        '📈✅ EMA cross confirmed — volume expanding',
        newConfirmedCrosses.length <= 3 ? newConfirmedCrosses.map((x) => x.ticker).join(', ') : `${newConfirmedCrosses.length} confirmed crosses`,
      );
    } else if (DASHBOARD_ALERTS.ema_cross_observe && newObservingOnly.length > 0) {
      try { crossObservePing(); } catch { /* audio context not unlocked */ }
    }

    // News radar — soft ping for each new entry (a fresh catalyst on a known
    // runner). Escalations don't ping here: the tick/screen paths that caused
    // them fire their own, stronger alerts.
    const newRadar = radarKeys.filter((n) => !seenRadar.current.has(n.key));
    newRadar.forEach((n) => seenRadar.current.add(n.key));
    if (DASHBOARD_ALERTS.news_radar && newRadar.length > 0) {
      try { newsRadarPing(); } catch { /* audio context not unlocked */ }
      notify(
        '📰 News radar — fresh catalyst, not moving yet',
        newRadar.length <= 3 ? newRadar.map((n) => n.ticker).join(', ') : `${newRadar.length} known runners with news`,
      );
    }

    // Live tick events — ping each new (ticker, tier) once, independent of the
    // catalyst/news events below (a tick catch is its own signal). A watch that
    // gets confirmed pings again with the stronger tone.
    const newTicks = tickKeys.filter((t) => !seenTicks.current.has(t.key));
    newTicks.forEach((t) => seenTicks.current.add(t.key));
    const newConfirmed = newTicks.filter((t) => t.status === 'confirmed').map((t) => t.ticker);
    const newWatches = newTicks.filter((t) => t.status === 'watch').map((t) => t.ticker);
    const newAccums = newTicks.filter((t) => t.status === 'accum').map((t) => t.ticker);
    if (DASHBOARD_ALERTS.tick_confirmed && newConfirmed.length > 0) {
      try { radarPing(); } catch { /* audio context not unlocked */ }
      notify(
        '🛰️ Live tick confirmed',
        newConfirmed.length <= 3 ? newConfirmed.join(', ') : `${newConfirmed.length} confirmed live ticks`,
      );
    } else if (DASHBOARD_ALERTS.tick_watch && newWatches.length > 0) {
      try { watchPing(); } catch { /* audio context not unlocked */ }
      notify(
        '👀 Tick watch — confirmation pending',
        newWatches.length <= 3 ? newWatches.join(', ') : `${newWatches.length} new tick watches`,
      );
    } else if (DASHBOARD_ALERTS.accum && newAccums.length > 0) {
      try { accumPing(); } catch { /* audio context not unlocked */ }
      notify(
        '🤫 Quiet accumulation — volume before price',
        newAccums.length <= 3 ? newAccums.join(', ') : `${newAccums.length} names accumulating`,
      );
    }

    // ↑ VWAP reclaims — one key per (ticker, episode, status): a reclaim tones
    // softly, its confirm pings brightly; a lost row is silent (the list greys
    // it). Seeded on the first payload like everything else.
    const vwapKeys = (payload.vwap_reclaims ?? [])
      .filter((v) => v.status !== 'lost')
      .map((v) => ({ key: `${v.ticker}:vwap:${v.reclaim_at}:${v.status}`, ticker: v.ticker, status: v.status }));
    const newVwap = vwapKeys.filter((v) => !seenTicks.current.has(v.key));
    newVwap.forEach((v) => seenTicks.current.add(v.key));
    const newVwapConfirmed = newVwap.filter((v) => v.status === 'confirmed').map((v) => v.ticker);
    const newVwapReclaimed = newVwap.filter((v) => v.status === 'reclaimed').map((v) => v.ticker);
    if (DASHBOARD_ALERTS.vwap_confirmed && newVwapConfirmed.length > 0) {
      try { crossConfirmPing(); } catch { /* audio context not unlocked */ }
      notify(
        '↑✅ VWAP reclaim confirmed — holding above session VWAP',
        newVwapConfirmed.length <= 3 ? newVwapConfirmed.join(', ') : `${newVwapConfirmed.length} confirmed VWAP reclaims`,
      );
    } else if (DASHBOARD_ALERTS.vwap_reclaimed && newVwapReclaimed.length > 0) {
      try { crossObservePing(); } catch { /* audio context not unlocked */ }
    }

    const { new_with_catalyst, fresh_news } = payload.banners;

    if (DASHBOARD_ALERTS.new_with_catalyst && new_with_catalyst.length > 0) {
      try { dingDing(); } catch { /* audio context not unlocked */ }
      notify(
        '🆕 New entrant with catalyst',
        new_with_catalyst.length <= 3
          ? new_with_catalyst.join(', ')
          : `${new_with_catalyst.length} new gainers with news`,
      );
    } else if (DASHBOARD_ALERTS.fresh_news && fresh_news.length > 0) {
      try { chime(); } catch { /* audio context not unlocked */ }
      notify(
        '🚨 Fresh news',
        fresh_news.length <= 3
          ? fresh_news.join(', ')
          : `${fresh_news.length} tickers with fresh news`,
      );
    }
  }, [payload]);
}

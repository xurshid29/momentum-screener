import { useEffect, useRef } from 'react';
import type { CyclePayload } from '../api/types';

// Browser equivalent of the bash script's audio + voice alerts. Events:
// • Tick WATCH (👀) — soft single ping, price-led early flag from the tick feed
// • Tick CONFIRMED (🛰️) — radar ping, the volume-confirmed tier
// • NEW + catalyst — distinct double-tone (fires even on first poll)
// • FRESH news (Benzinga delta) — single chime (suppressed on first cached payload)
// We dedupe per cycle_id to survive accidental SSE re-deliveries, and track
// already-seen (ticker, tier) pairs so a catch (which persists ~15 min) pings
// once per tier — a real runner gives exactly two pings: flag, then confirm.

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return audioCtx;
}

// Trader-friendly alert tone: sharp attack, ~70% sustain, brief decay.
// Layers a sine + a triangle one octave higher for more presence than a
// pure sine — cuts through background noise without being harsh.
function beep(frequency: number, durationMs: number, when = 0, peak = 0.55) {
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

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

function notify(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/vite.svg', tag: title });
    } catch {
      // some browsers throw if called outside a user gesture; ignore
    }
  }
}

export function useScreenerAlerts(payload: CyclePayload | null) {
  // Track cycle ids we've already handled so SSE replay (e.g. on reconnect) doesn't double-fire.
  const handled = useRef<Set<string>>(new Set());
  // Skip the very first payload (which is the cached snapshot the server pushes
  // immediately on subscribe — not a real new cycle).
  const seenFirst = useRef(false);
  // Tick catches persist ~15 min (many payloads); track (ticker, tier) keys
  // we've already pinged so each catch alerts once per tier, not every cycle.
  const seenTicks = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    const tickKeys = (payload.tick_catches ?? [])
      .filter((t) => t.status !== 'faded')
      .map((t) => ({ key: `${t.ticker}:${t.status ?? 'confirmed'}`, ticker: t.ticker, status: t.status ?? 'confirmed' }));

    if (!seenFirst.current) {
      seenFirst.current = true;
      // Seed seen ticks so catches already on screen at load don't all ping.
      tickKeys.forEach((t) => seenTicks.current.add(t.key));
      return;
    }

    // Live tick events — ping each new (ticker, tier) once, independent of the
    // catalyst/news events below (a tick catch is its own signal). A watch that
    // gets confirmed pings again with the stronger tone.
    const newTicks = tickKeys.filter((t) => !seenTicks.current.has(t.key));
    newTicks.forEach((t) => seenTicks.current.add(t.key));
    const newConfirmed = newTicks.filter((t) => t.status === 'confirmed').map((t) => t.ticker);
    const newWatches = newTicks.filter((t) => t.status === 'watch').map((t) => t.ticker);
    if (newConfirmed.length > 0) {
      try { radarPing(); } catch { /* audio context not unlocked */ }
      notify(
        '🛰️ Live tick confirmed',
        newConfirmed.length <= 3 ? newConfirmed.join(', ') : `${newConfirmed.length} confirmed live ticks`,
      );
    } else if (newWatches.length > 0) {
      try { watchPing(); } catch { /* audio context not unlocked */ }
      notify(
        '👀 Tick watch — confirmation pending',
        newWatches.length <= 3 ? newWatches.join(', ') : `${newWatches.length} new tick watches`,
      );
    }

    const { new_with_catalyst, fresh_news } = payload.banners;

    if (new_with_catalyst.length > 0) {
      try { dingDing(); } catch { /* audio context not unlocked */ }
      notify(
        '🆕 New entrant with catalyst',
        new_with_catalyst.length <= 3
          ? new_with_catalyst.join(', ')
          : `${new_with_catalyst.length} new gainers with news`,
      );
    } else if (fresh_news.length > 0) {
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

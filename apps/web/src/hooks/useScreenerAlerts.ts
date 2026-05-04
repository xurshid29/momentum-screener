import { useEffect, useRef } from 'react';
import type { CyclePayload } from '../api/types';

// Browser equivalent of the bash script's audio + voice alerts. Priority:
// 1) NEW + catalyst — distinct double-tone (highest, fires even on first poll)
// 2) FRESH news (Benzinga delta) — single chime (suppressed on first cached payload)
// We dedupe per cycle_id to survive accidental SSE re-deliveries.

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return audioCtx;
}

function beep(frequency: number, durationMs: number, when = 0) {
  const ac = ctx();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.frequency.value = frequency;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.0001, ac.currentTime + when);
  gain.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + when + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + when + durationMs / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(ac.currentTime + when);
  osc.stop(ac.currentTime + when + durationMs / 1000 + 0.05);
}

function dingDing() {
  beep(880, 180);          // A5
  beep(1320, 220, 0.18);   // E6
}

function chime() {
  beep(660, 200);          // E5
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

  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    if (!seenFirst.current) {
      seenFirst.current = true;
      return;
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

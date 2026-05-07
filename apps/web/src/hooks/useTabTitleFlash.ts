import { useEffect, useRef } from 'react';
import type { CyclePayload } from '../api/types';

// Flash the tab title when a NEW ticker with a today-catalyst appears
// (same trigger as the dingDing audio alert). Flashing only runs while the
// tab is hidden; focusing the tab clears the alert and restores the title.

const DEFAULT_TITLE = 'Momentum Screener';
const FLASH_INTERVAL_MS = 1000;

function alertTitle(tickers: string[]): string {
  if (tickers.length <= 3) return `🔥 NEW: ${tickers.join(', ')}`;
  return `🔥 ${tickers.length} new with news`;
}

export function useTabTitleFlash(payload: CyclePayload | null) {
  const handled = useRef<Set<string>>(new Set());
  const seenFirst = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const altTitleRef = useRef<string>(DEFAULT_TITLE);
  const flippedRef = useRef(false);

  // Stop flashing on tab focus and on unmount.
  useEffect(() => {
    function stop() {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      flippedRef.current = false;
      document.title = DEFAULT_TITLE;
    }
    function onVisibility() {
      if (!document.hidden) stop();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, []);

  // React to new cycles: start flashing if a new entrant has a catalyst.
  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    if (!seenFirst.current) {
      seenFirst.current = true;
      return;
    }

    const { new_with_catalyst } = payload.banners;
    if (new_with_catalyst.length === 0) return;
    if (!document.hidden) return;

    altTitleRef.current = alertTitle(new_with_catalyst);
    if (intervalRef.current != null) return;
    intervalRef.current = window.setInterval(() => {
      flippedRef.current = !flippedRef.current;
      document.title = flippedRef.current ? altTitleRef.current : DEFAULT_TITLE;
    }, FLASH_INTERVAL_MS);
  }, [payload]);
}

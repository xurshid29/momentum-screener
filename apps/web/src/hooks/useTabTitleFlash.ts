import { useEffect, useRef } from 'react';
import type { CyclePayload } from '../api/types';

// Tab-title alerts. Two modes, both only run while the tab is hidden and
// both reset on focus / unmount:
//   • flash (higher priority): a NEW ticker with a today-catalyst → 🔥
//   • static (lower priority): a NEW ticker without news       → 🆕
// Flash beats static; if a flash is already running we don't downgrade it.

const DEFAULT_TITLE = 'PNL Dash';
const FLASH_INTERVAL_MS = 1000;

function flashTitle(count: number): string {
  return `${DEFAULT_TITLE} (🔥 ${count} news)`;
}

function staticTitle(count: number): string {
  return `${DEFAULT_TITLE} (${count} new)`;
}

export function useTabTitleFlash(payload: CyclePayload | null) {
  const handled = useRef<Set<string>>(new Set());
  const seenFirst = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const altTitleRef = useRef<string>(DEFAULT_TITLE);
  const flippedRef = useRef(false);

  // Reset on tab focus and on unmount.
  useEffect(() => {
    function reset() {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      flippedRef.current = false;
      document.title = DEFAULT_TITLE;
    }
    function onVisibility() {
      if (!document.hidden) reset();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      reset();
    };
  }, []);

  // React to new cycles: flash for NEW+catalyst, static for NEW without news.
  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    if (!seenFirst.current) {
      seenFirst.current = true;
      return;
    }
    if (!document.hidden) return;

    const newWithCatalyst = payload.banners.new_with_catalyst;
    const newWithoutNews = payload.rows
      .filter((r) => r.status === 'NEW' && !r.has_today_news)
      .map((r) => r.ticker);

    if (newWithCatalyst.length > 0) {
      altTitleRef.current = flashTitle(newWithCatalyst.length);
      if (intervalRef.current != null) return;
      intervalRef.current = window.setInterval(() => {
        flippedRef.current = !flippedRef.current;
        document.title = flippedRef.current ? altTitleRef.current : DEFAULT_TITLE;
      }, FLASH_INTERVAL_MS);
    } else if (newWithoutNews.length > 0) {
      // Don't downgrade an in-progress flash to a static title.
      if (intervalRef.current != null) return;
      document.title = staticTitle(newWithoutNews.length);
    }
  }, [payload]);
}

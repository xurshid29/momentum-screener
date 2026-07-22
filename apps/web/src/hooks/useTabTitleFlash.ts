import { useEffect, useRef } from 'react';
import type { CyclePayload } from '../api/types';

// Tab-title alerts — only run while the tab is hidden, reset on focus /
// unmount. Reworked 2026-07-22 (operator's call, same sweep as the sound
// kill switches): the EMA-cross layer is the only component allowed to
// touch the title; the legacy momentum/ignition modes are disabled, not
// deleted — flip their flags to restore.
//   • ema confirm (highest): a cross volume-confirmed → flashing "📈✅ N"
//   • ema observe (lower):   a new cross appeared     → static  "📈 N cross"
const TITLE_ALERTS: Record<
  'ema_cross_confirm' | 'ema_cross_observe' | 'momentum_new_catalyst' | 'ignition_new' | 'momentum_new',
  boolean
> = {
  ema_cross_confirm: true,
  ema_cross_observe: true,
  momentum_new_catalyst: false,
  ignition_new: false,
  momentum_new: false,
};

const DEFAULT_TITLE = 'PNL Dash';
const FLASH_INTERVAL_MS = 1000;

function crossConfirmTitle(count: number): string {
  return `${DEFAULT_TITLE} (📈✅ ${count} confirmed)`;
}

function crossObserveTitle(count: number): string {
  return `${DEFAULT_TITLE} (📈 ${count} cross${count === 1 ? '' : 'es'})`;
}

function flashTitle(count: number): string {
  return `${DEFAULT_TITLE} (🔥 ${count} news)`;
}

function ignitionTitle(count: number): string {
  return `${DEFAULT_TITLE} (⚡ ${count} ignition${count === 1 ? '' : 's'})`;
}

function staticTitle(count: number): string {
  return `${DEFAULT_TITLE} (${count} new)`;
}

export function useTabTitleFlash(payload: CyclePayload | null) {
  const handled = useRef<Set<string>>(new Set());
  const seenFirst = useRef(false);
  const seenCross = useRef<Set<string>>(new Set());
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

  useEffect(() => {
    if (!payload) return;
    if (handled.current.has(payload.cycle_id)) return;
    handled.current.add(payload.cycle_id);

    // Track cross identities across cycles (rows persist for many payloads —
    // only genuinely new events may touch the title). Marked even while the
    // tab is visible, so backgrounding the tab doesn't back-blast old rows.
    const confirmKeys = (payload.ema_crosses ?? [])
      .filter((x) => x.status === 'confirmed')
      .map((x) => `${x.tf}|${x.ticker}:${x.confirmed_at}`);
    const observeKeys = (payload.ema_crosses ?? [])
      .map((x) => ({ key: `${x.tf}|${x.ticker}:${x.cross_at}`, confirmed: x.status === 'confirmed' }));

    if (!seenFirst.current) {
      seenFirst.current = true;
      confirmKeys.forEach((k) => seenCross.current.add(k));
      observeKeys.forEach((o) => seenCross.current.add(o.key));
      return;
    }

    const newConfirms = confirmKeys.filter((k) => !seenCross.current.has(k));
    newConfirms.forEach((k) => seenCross.current.add(k));
    const newObserving = observeKeys.filter((o) => !seenCross.current.has(o.key));
    newObserving.forEach((o) => seenCross.current.add(o.key));
    const newObservingOnly = newObserving.filter((o) => !o.confirmed);

    if (!document.hidden) return;

    if (TITLE_ALERTS.ema_cross_confirm && newConfirms.length > 0) {
      altTitleRef.current = crossConfirmTitle(newConfirms.length);
      if (intervalRef.current != null) return;
      intervalRef.current = window.setInterval(() => {
        flippedRef.current = !flippedRef.current;
        document.title = flippedRef.current ? altTitleRef.current : DEFAULT_TITLE;
      }, FLASH_INTERVAL_MS);
      return;
    }
    if (TITLE_ALERTS.ema_cross_observe && newObservingOnly.length > 0) {
      // Don't downgrade an in-progress confirm flash to a static title.
      if (intervalRef.current != null) return;
      document.title = crossObserveTitle(newObservingOnly.length);
      return;
    }

    // ── Legacy modes (disabled above; kept intact for easy re-enable) ──
    const newWithCatalyst = payload.banners.new_with_catalyst;
    const newIgnitionCount = payload.ignition.filter((r) => r.is_new).length;
    const newWithoutNews = payload.rows
      .filter((r) => r.status === 'NEW' && !r.has_today_news)
      .map((r) => r.ticker);

    if (TITLE_ALERTS.momentum_new_catalyst && newWithCatalyst.length > 0) {
      altTitleRef.current = flashTitle(newWithCatalyst.length);
      if (intervalRef.current != null) return;
      intervalRef.current = window.setInterval(() => {
        flippedRef.current = !flippedRef.current;
        document.title = flippedRef.current ? altTitleRef.current : DEFAULT_TITLE;
      }, FLASH_INTERVAL_MS);
    } else if (TITLE_ALERTS.ignition_new && newIgnitionCount > 0) {
      if (intervalRef.current != null) return;
      document.title = ignitionTitle(newIgnitionCount);
    } else if (TITLE_ALERTS.momentum_new && newWithoutNews.length > 0) {
      if (intervalRef.current != null) return;
      document.title = staticTitle(newWithoutNews.length);
    }
  }, [payload]);
}

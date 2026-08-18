import { useEffect, useRef } from 'react';
import type { EdgeEvent } from '../api/types';
import { edgeAlertPing, notifyEdge } from './useScreenerAlerts';

function enabled(event: EdgeEvent): boolean {
  return event.event === 'armed' ? event.snapshot.alert_armed
    : event.event === 'entry' ? event.snapshot.alert_entry
      : event.event === 'bailout' ? event.snapshot.alert_bailout
        : false;
}

export function useEdgeAlerts(events: EdgeEvent[], ready = true) {
  const seeded = useRef(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!ready) return;
    if (!seeded.current) {
      seeded.current = true;
      events.forEach((event) => seen.current.add(event.id));
      return;
    }
    // The API returns newest first; announce unseen transitions in the order
    // they actually happened (armed before entry before bailout).
    const chronological = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const event of chronological) {
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      if (!enabled(event)) continue;
      try { edgeAlertPing(event.event); } catch { /* browser audio remains best-effort */ }
      const title = event.event === 'armed'
        ? `🟡 Edge armed — ${event.ticker}`
        : event.event === 'entry'
          ? `🟢 Edge entry — ${event.ticker}`
          : `🔴 Edge bailout — ${event.ticker}`;
      const setup = event.setup?.replaceAll('_', ' ') ?? 'decision zone';
      const body = `${setup} · $${event.price.toFixed(4)}${event.bailout != null ? ` · bailout $${event.bailout.toFixed(4)}` : ''}`;
      notifyEdge(title, body);
    }
  }, [events, ready]);
}

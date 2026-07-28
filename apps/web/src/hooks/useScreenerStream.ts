import { useEffect, useState } from 'react';
import type { CyclePayload } from '../api/types';

// Empty → EventSource uses the page's origin. Dev: vite proxy. Prod: nginx.
const API_URL = import.meta.env.VITE_API_URL || '';

// Subscribes to /api/screener/stream via EventSource. Token goes in query
// string because EventSource can't set Authorization headers.
export function useScreenerStream(): { payload: CyclePayload | null; connected: boolean } {
  const [payload, setPayload] = useState<CyclePayload | null>(null);
  const [connected, setConnected] = useState(false);

  // Seed the board from /latest on mount (2026-07-28). The stream replays the
  // last cycle on connect, but that cache is empty for up to one poll (~20s)
  // after every API restart — so a reload right after a deploy rendered a
  // blank dashboard. /latest now falls back to the last PERSISTED cycle, so
  // this paints immediately either way. A live cycle always wins: the seed is
  // dropped if the stream has already delivered one (the guard below), and
  // every later `cycle` event overwrites it.
  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch(`${API_URL}/api/screener/latest`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.data?.polled_at) return;
        setPayload((cur) => cur ?? j.data);
      })
      .catch(() => { /* the stream is the real source — never block on this */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    const url = `${API_URL}/api/screener/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('cycle', (ev) => {
      try {
        setPayload(JSON.parse((ev as MessageEvent).data));
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { payload, connected };
}

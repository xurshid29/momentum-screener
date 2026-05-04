import { useEffect, useState } from 'react';
import type { CyclePayload } from '../api/types';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Subscribes to /api/screener/stream via EventSource. Token goes in query
// string because EventSource can't set Authorization headers.
export function useScreenerStream(): { payload: CyclePayload | null; connected: boolean } {
  const [payload, setPayload] = useState<CyclePayload | null>(null);
  const [connected, setConnected] = useState(false);

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

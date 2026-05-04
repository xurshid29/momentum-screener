import { useEffect, useRef, useState } from 'react';

interface TradingViewWidgetProps {
  symbol: string;          // e.g. "NASDAQ:AAPL" — we pass the bare ticker, TV resolves the exchange.
  interval: string;        // 1, 5, 15, 60, 240, D, ...
  containerId: string;     // must be unique per widget on the page
  theme?: 'light' | 'dark';
  studies?: string[];      // TV study identifiers, e.g. ['VWAP@tv-basicstudies', 'RSI@tv-basicstudies']
  studiesOverrides?: Record<string, unknown>;  // TV `studies_overrides` — used to set indicator params (e.g. EMA length)
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';
let scriptPromise: Promise<void> | null = null;

function loadTvScript(): Promise<void> {
  if (window.TradingView) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TV_SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load TradingView script'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function TradingViewWidget({ symbol, interval, containerId, theme = 'dark', studies, studiesOverrides }: TradingViewWidgetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  // Stable join keys so React only rebuilds the widget when these actually change.
  const studiesKey = (studies ?? []).join(',');
  const overridesKey = studiesOverrides ? JSON.stringify(studiesOverrides) : '';

  useEffect(() => {
    let cancelled = false;
    let hideOverlayTimer: number | null = null;
    let iframeListener: (() => void) | null = null;
    setLoading(true);

    loadTvScript()
      .then(() => {
        if (cancelled || !ref.current || !window.TradingView) return;
        ref.current.innerHTML = '';
        new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: 'America/New_York',
          theme,
          style: '1',
          locale: 'en',
          enable_publishing: false,
          allow_symbol_change: false,
          extended_hours: true,
          session: 'extended',
          container_id: containerId,
          ...(studies && studies.length > 0 ? { studies } : {}),
          ...(studiesOverrides && Object.keys(studiesOverrides).length > 0 ? { studies_overrides: studiesOverrides } : {}),
        });

        // The widget mounts an iframe inside our container. The iframe's own
        // body is white by default, so we keep our dark overlay on top until
        // either the iframe `load` event fires OR a fallback timeout elapses
        // (some TV builds load lazily and don't fire `load` reliably).
        const findAndAttach = () => {
          const iframe = ref.current?.querySelector('iframe');
          if (!iframe) return false;
          iframeListener = () => {
            // Slight delay after load so TV's dark theme has a chance to paint
            // inside the iframe before we lift the overlay.
            window.setTimeout(() => { if (!cancelled) setLoading(false); }, 250);
          };
          iframe.addEventListener('load', iframeListener);
          return true;
        };
        // Iframe creation by TV is async; poll briefly.
        let attempts = 0;
        const poll = window.setInterval(() => {
          if (cancelled || findAndAttach() || ++attempts > 20) {
            window.clearInterval(poll);
          }
        }, 50);

        // Hard fallback — never leave the overlay up forever.
        hideOverlayTimer = window.setTimeout(() => {
          if (!cancelled) setLoading(false);
        }, 2500);
      })
      .catch(() => {
        if (ref.current) ref.current.innerHTML = '<div style="padding:1em;color:#888">Chart failed to load</div>';
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (hideOverlayTimer) window.clearTimeout(hideOverlayTimer);
      const iframe = ref.current?.querySelector('iframe');
      if (iframe && iframeListener) iframe.removeEventListener('load', iframeListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, containerId, theme, studiesKey, overridesKey]);

  return (
    <div className="tv-slot" style={{ position: 'relative', width: '100%', height: '100%', background: '#1a1a1a' }}>
      <div id={containerId} ref={ref} style={{ width: '100%', height: '100%' }} />
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: '#1a1a1a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#666',
            fontSize: 12,
            transition: 'opacity 0.2s',
            pointerEvents: 'none',
          }}
        >
          loading…
        </div>
      )}
    </div>
  );
}

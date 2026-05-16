// Nasdaq trade-halt feed client.
//
// One request per cycle to the consolidated Nasdaq trade-halt RSS feed, which
// carries every US-equity halt/pause across all listing markets for the
// current day. For a momentum screener a halt is a first-class signal: a T1
// ("news pending") halt means a catalyst is landing right now and the tape is
// frozen for it; an LULD pause means the move just went vertical.

const FEED_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
const UA = 'Mozilla/5.0';
const TIMEOUT_MS = 6000;

export interface TradeHalt {
  ticker: string;
  reasonCode: string;          // Nasdaq reason code, e.g. 'T1', 'T2', 'LUDP'
  title: string;               // synthesized headline for the news feed
  haltedAt: Date;
  resumesAt: Date | null;
  issueName: string;
  market: string;
  url: string;                 // synthetic unique key — halts have no canonical URL
  raw: Record<string, string>;
}

export interface HaltDelta {
  halts: TradeHalt[];          // today's halts in ET, newest first
  freshTickers: Set<string>;   // tickers halted since prevWatermark
  newWatermark: number;        // max halt ts seen (unix seconds)
}

const REASON_TEXT: Record<string, string> = {
  T1: 'news pending',
  T2: 'news released',
  T3: 'news & resumption',
  T5: 'single-stock volatility pause',
  T6: 'extraordinary market activity',
  T7: 'single-stock trading pause',
  T8: 'ETF / component issue',
  T12: 'additional information requested',
  H4: 'not current with filings',
  H9: 'not current with filings',
  H10: 'SEC trading suspension',
  H11: 'regulatory concern',
  LUDP: 'LULD volatility pause',
  M: 'LULD volatility pause',
  D: 'operations halt',
  O1: 'operations halt',
  IPO1: 'IPO — not yet trading',
  IPOQ: 'IPO — quotation period',
  MWC1: 'market-wide circuit breaker',
  MWC2: 'market-wide circuit breaker',
  MWC3: 'market-wide circuit breaker',
  MWC0: 'market-wide circuit breaker',
};

function reasonText(code: string): string {
  return REASON_TEXT[code.toUpperCase()] ?? 'trading halt';
}

export async function fetchHalts(
  prevWatermark: number,
  todayEt: string,
): Promise<HaltDelta | null> {
  let xml: string;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  let newWatermark = prevWatermark;
  const fresh = new Set<string>();
  const halts: TradeHalt[] = [];

  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const symbol = ndaq(block, 'IssueSymbol')?.toUpperCase();
    const code = ndaq(block, 'ReasonCode')?.toUpperCase();
    const haltDate = ndaq(block, 'HaltDate'); // MM/DD/YYYY
    const haltTime = ndaq(block, 'HaltTime'); // HH:MM:SS(.mmm)
    if (!symbol || !code || !haltDate || !haltTime) continue;

    const haltedAt = etWallClockToDate(haltDate, haltTime);
    if (!haltedAt) continue;
    if (todayEt && etDateString(haltedAt) !== todayEt) continue;

    const ts = Math.floor(haltedAt.getTime() / 1000);
    if (ts > newWatermark) newWatermark = ts;
    if (ts > prevWatermark) fresh.add(symbol);

    const resDate = ndaq(block, 'ResumptionDate');
    const resTime = ndaq(block, 'ResumptionTradeTime');
    const resumesAt = resDate && resTime ? etWallClockToDate(resDate, resTime) : null;
    const issueName = ndaq(block, 'IssueName') ?? '';
    const market = ndaq(block, 'Market') ?? '';

    const title = resumesAt
      ? `Trading halt — ${reasonText(code)} (${code}) · resumes ${hhmm(resumesAt)} ET`
      : `Trading halt — ${reasonText(code)} (${code})`;

    halts.push({
      ticker: symbol,
      reasonCode: code,
      title,
      haltedAt,
      resumesAt,
      issueName,
      market,
      url: `halt://${symbol}/${haltDate.replace(/\D/g, '')}/${haltTime.replace(/\D/g, '')}/${code}`,
      raw: {
        symbol,
        reasonCode: code,
        haltDate,
        haltTime,
        issueName,
        market,
        resumptionDate: resDate ?? '',
        resumptionTradeTime: resTime ?? '',
      },
    });
  }

  halts.sort((a, b) => b.haltedAt.getTime() - a.haltedAt.getTime());
  return { halts, freshTickers: fresh, newWatermark };
}

// Extract a non-empty <ndaq:Name> value. Self-closing empty tags → null.
function ndaq(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<ndaq:${name}>([\\s\\S]*?)<\\/ndaq:${name}>`));
  if (!m) return null;
  const v = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  return v.length > 0 ? v : null;
}

// Nasdaq reports HaltDate (MM/DD/YYYY) and HaltTime (HH:MM:SS) as ET
// wall-clock. Build a UTC guess from the components, then correct by the
// actual ET offset on that date (handles EST/EDT automatically).
function etWallClockToDate(dateStr: string, timeStr: string): Date | null {
  const d = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const t = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})/);
  if (!d || !t) return null;
  const utcGuess = new Date(Date.UTC(+d[3], +d[1] - 1, +d[2], +t[1], +t[2], +t[3]));
  if (Number.isNaN(utcGuess.getTime())) return null;
  return new Date(utcGuess.getTime() - etOffsetMs(utcGuess));
}

function etOffsetMs(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  const etMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  return etMs - at.getTime();
}

function etDateString(dt: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dt);
}

function hhmm(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

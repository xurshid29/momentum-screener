// Conditional EMA/MACD entry-timing study (2026-07-05).
// Question: on catalyst-selected known runners (bullish article ≤24h before our
// detection), does entering at the first EMA6/20(+MACD) cross AFTER the news
// beat (a) entering on the news bar (radar-style) and (b) entering at our
// detection — measured as peak capture to a SHARED finish line (news+24h/+72h)?
//
// Data: events.csv (prod export), Yahoo 15m×60d prepost bars (cached).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DIR = process.env.STUDY_DIR ?? '/tmp/ema-macd-study';
const CACHE = `${DIR}/yahoo`;
mkdirSync(CACHE, { recursive: true });

interface Ev {
  ticker: string; et_date: string; det_ts: number; news_ts: number | null;
  impact: number | null; urgency: string; ctype: string;
}
interface Bar { ts: number; h: number; c: number }

// ── load events ──
const rows = readFileSync(`${DIR}/events.csv`, 'utf8').trim().split('\n').slice(1);
const events: Ev[] = rows.map((ln) => {
  const p = ln.split(',');
  return {
    ticker: p[0], et_date: p[1], det_ts: +p[2],
    news_ts: p[3] ? +p[3] : null,
    impact: p[4] ? +p[4] : null, urgency: p[6] ?? '', ctype: p[7] ?? '',
  };
});
const catEvents = events.filter((e) => e.news_ts != null);
const tickers = [...new Set(catEvents.map((e) => e.ticker))];
console.log(`events: ${events.length} total, ${catEvents.length} catalyst; ${tickers.length} tickers to fetch`);

// ── fetch Yahoo 15m bars (cached) ──
async function fetchBars(tk: string): Promise<Bar[] | null> {
  const cf = `${CACHE}/${tk}.json`;
  let json: unknown;
  if (existsSync(cf)) {
    json = JSON.parse(readFileSync(cf, 'utf8'));
  } else {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tk)}?interval=15m&range=60d&includePrePost=true`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.status === 404) { writeFileSync(cf, 'null'); return null; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
        writeFileSync(cf, JSON.stringify(json));
        break;
      } catch (err) {
        if (attempt === 1) { console.error(`  fetch failed ${tk}: ${err}`); return null; }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  const r0 = (json as any)?.chart?.result?.[0];
  const ts: number[] = r0?.timestamp ?? [];
  const q = r0?.indicators?.quote?.[0];
  if (!ts.length || !q) return null;
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null) continue;
    bars.push({ ts: ts[i], h: q.high[i], c: q.close[i] });
  }
  return bars.length >= 60 ? bars : null;
}

// ── indicators (TV-faithful enough: EMA with SMA seed) ──
function ema(vals: number[], n: number): number[] {
  const out = new Array(vals.length).fill(NaN);
  const k = 2 / (n + 1);
  let seed = 0;
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) { seed += vals[i]; continue; }
    if (i === n - 1) { seed += vals[i]; out[i] = seed / n; continue; }
    out[i] = vals[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}
interface Ind { emaF: number[]; emaS: number[]; macd: number[]; hist: number[] }
function indicators(closes: number[]): Ind {
  const emaF = ema(closes, 6), emaS = ema(closes, 20);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const macdClean = macd.map((v) => (Number.isNaN(v) ? 0 : v));
  const sig = ema(macdClean, 9);
  const hist = macd.map((v, i) => v - sig[i]);
  return { emaF, emaS, macd, hist };
}
// cross indices for a bar series
function crosses(bars: Bar[], variant: 'ema' | 'conf'): number[] {
  const closes = bars.map((b) => b.c);
  const { emaF, emaS, macd, hist } = indicators(closes);
  const out: number[] = [];
  for (let i = 30; i < bars.length; i++) {
    if (Number.isNaN(emaF[i - 1]) || Number.isNaN(emaS[i - 1])) continue;
    const crossed = emaF[i - 1] <= emaS[i - 1] && emaF[i] > emaS[i];
    if (!crossed) continue;
    if (variant === 'conf') {
      if (!(hist[i] >= 0 && hist[i] > hist[i - 1] && macd[i] > macd[i - 1])) continue;
    }
    out.push(i);
  }
  return out;
}
function aggregate30(bars: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const b of bars) {
    const bucket = Math.floor(b.ts / 1800) * 1800;
    const cur = map.get(bucket);
    if (!cur) map.set(bucket, { ts: bucket, h: b.h, c: b.c });
    else { cur.h = Math.max(cur.h, b.h); cur.c = b.c; }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

// bar containing ts, else first bar after ts (entry at that bar's close)
function entryIdx(bars: Bar[], ts: number, intervalSec: number): number | null {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ts + intervalSec > ts && bars[i].ts <= ts) return i;
    if (bars[i].ts > ts) return i;
  }
  return null;
}
function peakPct(bars: Bar[], idx: number, finishTs: number): number | null {
  let peak = -Infinity;
  let n = 0;
  for (let j = idx + 1; j < bars.length && bars[j].ts <= finishTs; j++) { peak = Math.max(peak, bars[j].h); n++; }
  if (n < 2) return null;
  return (peak / bars[idx].c - 1) * 100;
}

// ── stats helpers ──
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const winRate = (xs: number[], th: number) => (xs.filter((x) => x >= th).length / xs.length) * 100;
const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(1);

interface Result {
  ticker: string; et_date: string; impact: number | null; urgency: string; ctype: string;
  newsToDetMin: number;
  crossConf15LagMin: number | null;  // news → cross (null = never fired in 24h)
  crossBeatsDetMin: number | null;   // det - cross (positive = cross earlier)
  cap: Record<string, Record<string, number | null>>; // horizon → strategy → capture
}

const results: Result[] = [];
let fetched = 0, noBars = 0;
const barsCache = new Map<string, Bar[]>();

for (const tk of tickers) {
  const bars = await fetchBars(tk);
  fetched++;
  if (fetched % 50 === 0) console.log(`  ...${fetched}/${tickers.length} tickers`);
  if (!bars) { noBars++; continue; }
  barsCache.set(tk, bars);
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`bars: ${barsCache.size} tickers ok, ${noBars} missing`);

const IV15 = 900, IV30 = 1800;
for (const e of catEvents) {
  const bars = barsCache.get(e.ticker);
  if (!bars || e.news_ts == null) continue;
  const bars30 = aggregate30(bars);
  const xEma15 = crosses(bars, 'ema');
  const xConf15 = crosses(bars, 'conf');
  const xConf30 = crosses(bars30, 'conf');

  const iNews = entryIdx(bars, e.news_ts, IV15);
  const iDet = entryIdx(bars, e.det_ts, IV15);
  if (iNews == null || iDet == null) continue;
  const crossDeadline = e.news_ts + 24 * 3600;
  const firstCross = (xs: number[], series: Bar[], afterTs: number) => {
    for (const i of xs) if (series[i].ts >= afterTs - IV15 && series[i].ts <= crossDeadline && series[i].ts + IV15 > e.news_ts) return i;
    return null;
  };
  // first qualifying cross bar whose CLOSE is at/after the news (bar may contain the news)
  const cEma15 = xEma15.find((i) => bars[i].ts + IV15 > e.news_ts && bars[i].ts <= crossDeadline) ?? null;
  const cConf15 = xConf15.find((i) => bars[i].ts + IV15 > e.news_ts && bars[i].ts <= crossDeadline) ?? null;
  const cConf30 = xConf30.find((i) => bars30[i].ts + IV30 > e.news_ts && bars30[i].ts <= crossDeadline) ?? null;
  void firstCross;

  const res: Result = {
    ticker: e.ticker, et_date: e.et_date, impact: e.impact, urgency: e.urgency, ctype: e.ctype,
    newsToDetMin: (e.det_ts - e.news_ts) / 60,
    crossConf15LagMin: cConf15 != null ? (bars[cConf15].ts + IV15 - e.news_ts) / 60 : null,
    crossBeatsDetMin: cConf15 != null ? (e.det_ts - (bars[cConf15].ts + IV15)) / 60 : null,
    cap: {},
  };
  for (const [hName, hSec] of [['24h', 24 * 3600], ['72h', 72 * 3600]] as const) {
    const finish = e.news_ts + hSec;
    if (bars[bars.length - 1].ts < finish) { res.cap[hName] = { censored: 1 } as never; continue; }
    res.cap[hName] = {
      news: peakPct(bars, iNews, finish),
      det: peakPct(bars, iDet, finish),
      crossEma15: cEma15 != null ? peakPct(bars, cEma15, finish) : null,
      crossConf15: cConf15 != null ? peakPct(bars, cConf15, finish) : null,
      crossConf30: cConf30 != null ? peakPct(bars30, cConf30, finish) : null,
    };
  }
  results.push(res);
}

writeFileSync(`${DIR}/study-results.json`, JSON.stringify(results));
console.log(`\nusable catalyst events: ${results.length}\n`);

// ── report ──
function report(label: string, evs: Result[]) {
  console.log(`\n═══ ${label} (n=${evs.length}) ═══`);
  const lags = evs.map((r) => r.newsToDetMin);
  console.log(`news → our detection: median ${q(lags, 0.5).toFixed(0)}min  [p25 ${q(lags, 0.25).toFixed(0)}, p75 ${q(lags, 0.75).toFixed(0)}]`);
  const fired = evs.filter((r) => r.crossConf15LagMin != null);
  console.log(`conf-cross(15m) fired ≤24h after news: ${fired.length}/${evs.length} (${(fired.length / evs.length * 100).toFixed(0)}%)` +
    (fired.length ? ` · news→cross median ${q(fired.map((r) => r.crossConf15LagMin!), 0.5).toFixed(0)}min` : ''));
  if (fired.length) {
    const before = fired.filter((r) => r.crossBeatsDetMin! > 0);
    console.log(`cross BEFORE our detection: ${before.length}/${fired.length} (${(before.length / fired.length * 100).toFixed(0)}%)` +
      (before.length ? ` · median lead ${q(before.map((r) => r.crossBeatsDetMin!), 0.5).toFixed(0)}min` : ''));
  }
  for (const h of ['24h', '72h'] as const) {
    console.log(`\n  peak capture to news+${h} (median [p25,p75] · mean · %≥+20):`);
    for (const s of ['news', 'crossEma15', 'crossConf15', 'crossConf30', 'det'] as const) {
      const xs = evs.map((r) => r.cap[h]?.[s]).filter((x): x is number => typeof x === 'number');
      if (xs.length < 5) { console.log(`    ${s.padEnd(12)} n=${xs.length} (too few)`); continue; }
      console.log(`    ${s.padEnd(12)} n=${String(xs.length).padStart(4)}  ${fmt(q(xs, 0.5)).padStart(7)}% [${fmt(q(xs, 0.25))}, ${fmt(q(xs, 0.75))}]  mean ${fmt(mean(xs)).padStart(7)}%  ≥+20%: ${winRate(xs, 20).toFixed(0)}%`);
    }
    // paired: cross-conf15 vs news and vs det on the SAME events
    const paired = evs.filter((r) => typeof r.cap[h]?.crossConf15 === 'number' && typeof r.cap[h]?.news === 'number' && typeof r.cap[h]?.det === 'number');
    if (paired.length >= 5) {
      const dNews = paired.map((r) => (r.cap[h].crossConf15 as number) - (r.cap[h].news as number));
      const dDet = paired.map((r) => (r.cap[h].crossConf15 as number) - (r.cap[h].det as number));
      console.log(`    paired (n=${paired.length}): cross−news median ${fmt(q(dNews, 0.5))}pts · cross−det median ${fmt(q(dDet, 0.5))}pts`);
      // opportunity-cost view: wait-for-cross strategy = 0 when no cross fired
      const all = evs.filter((r) => typeof r.cap[h]?.news === 'number');
      const waitCross = all.map((r) => typeof r.cap[h]?.crossConf15 === 'number' ? r.cap[h].crossConf15 as number : 0);
      const newsAll = all.map((r) => r.cap[h].news as number);
      console.log(`    incl. no-trades (cross=0 when never fired, n=${all.length}): wait-for-cross mean ${fmt(mean(waitCross))}% vs news-entry mean ${fmt(mean(newsAll))}%`);
    }
  }
}

report('ALL catalyst events', results);
report('impact ≥ 60', results.filter((r) => (r.impact ?? 0) >= 60));
report('urgency strong/major', results.filter((r) => r.urgency === 'strong' || r.urgency === 'major'));
report('premium types (fda/clinical/halt/contract)', results.filter((r) => /fda|clinic|halt|contract/i.test(r.ctype)));

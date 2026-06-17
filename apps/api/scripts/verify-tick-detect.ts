// Replays the validation data through the production TickDetector to confirm
// the TS port reproduces the offline (Python) result: DSY/GLXG/SUNE fire early,
// blips rejected, ~5% control false-fire rate. Run: npx tsx scripts/verify-tick-detect.ts
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TickDetector, type TickBar } from '../src/services/tick-detect.js';

// EQUS.MINI sample CSVs from the offline validation (gitignored data/ dir).
// Re-pull them to re-run this regression check. Override with TICK_DATA_DIR.
const DIR = process.env.TICK_DATA_DIR
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/dbpull');

// runner -> [prior_close, finviz_utc, finviz_chg]
const RUNNERS: Record<string, [number, string, number]> = {
  'INHD_2026-06-08': [1.05, '2026-06-08T13:44:31', 94.3],
  'SUNE_2026-06-08': [1.13, '2026-06-08T10:50:50', 109.7],
  'BYAH_2026-06-08': [1.06, '2026-06-08T17:18:32', 59.0],
  'NPT_2026-06-08':  [1.29, '2026-06-08T14:46:31', 36.4],
  'AZI_2026-06-09':  [1.13, '2026-06-09T11:32:34', 23.9],
  'RGNT_2026-06-09': [1.28, '2026-06-09T08:01:32', 142.2],
  'CIIT_2026-06-10': [1.20, '2026-06-10T08:03:13', 30.8],
  'DSY_2026-06-10':  [1.84, '2026-06-10T11:43:13', 28.8],
  'GLXG_2026-06-11': [0.976,'2026-06-11T08:06:10', 55.7],
  'PPCB_2026-06-11': [1.35, '2026-06-11T09:32:19', 60.0],
  'RGNT_2026-06-15': [1.50, '2026-06-15T13:41:06', 40.6],
};
const CONTROL_PRIOR: Record<string, number> = {
  BMHL:5.45,ITOC:0.395,CTNT:1.92,TURB:1.54,HUDI:0.843,FEBO:1.17,BANL:0.384,MWG:1.41,LGPS:0.76,JYD:0.715,
  AEHL:1.02,TANH:0.46,LZMH:1.49,EJH:2.05,SNTG:2.21,LHSW:0.162,LXEH:1.41,SCKT:0.842,LSTA:3.46,SUGP:1.00,
  ONEG:0.95,AMS:1.50,FTFT:0.923,MGIH:1.69,IBG:1.20,ANNA:3.11,HIHO:0.83,VVOS:0.70,NUWE:0.145,INEO:0.61,
  FEED:0.748,IPW:3.77,TAOP:1.39,INDO:2.65,HTCO:4.47,MSGY:0.599,LESL:8.18,HCWB:1.18,YAAS:0.89,CRVO:2.89,
};

const tsSec = (iso: string) => Math.floor(Date.parse(iso + 'Z') / 1000);  // treat as UTC
const hms = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 19);

function parseRows(csv: string): { ts: number; bar: TickBar; symbol?: string }[] {
  const lines = csv.trim().split('\n');
  const hdr = lines[0].split(',');
  const ci = (n: string) => hdr.indexOf(n);
  const [iT, iH, iL, iC, iV, iS] = [ci('ts_event'), ci('high'), ci('low'), ci('close'), ci('volume'), ci('symbol')];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 5) continue;
    const ts = Math.floor(Date.parse(c[iT].slice(0, 19) + 'Z') / 1000);
    out.push({
      ts,
      bar: { ts_sec: ts, close: +c[iC], high: +c[iH], low: +c[iL], volume: +c[iV] },
      symbol: iS >= 0 ? c[iS] : undefined,
    });
  }
  return out;
}

console.log('=== RUNNERS — does the detector fire EARLY (before Finviz)? ===\n');
for (const [name, [prior, futc, fchg]] of Object.entries(RUNNERS)) {
  const path = `${DIR}/${name}.csv`;
  let rows;
  try { rows = parseRows(readFileSync(path, 'utf8')); } catch { console.log(`${name}: no file`); continue; }
  const det = new TickDetector();
  det.setPriorClose(name.split('_')[0], prior);
  const fts = tsSec(futc);
  let fire = null;
  for (const r of rows) {
    const c = det.addBar(name.split('_')[0], r.bar);
    if (c) { fire = c; break; }
  }
  if (!fire) { console.log(`${name.padEnd(16)} finviz ${('+'+fchg+'%').padStart(7)} | no fire`); continue; }
  const lead = fts - fire.ts_sec;
  const tag = lead > 0 ? `${lead}s EARLIER` : `${-lead}s later`;
  console.log(`${name.padEnd(16)} finviz ${('+'+fchg+'%').padStart(7)} | fire ${hms(fire.ts_sec)} ` +
    `at +${fire.change_pct.toFixed(0)}% (rv ${fire.rel_vol}x) — ${tag}`);
}

console.log('\n=== CONTROL — false-fire rate on 38 fizzlers (peak <25%) ===\n');
const cfile = readdirSync(DIR).find((f) => f.startsWith('control_'));
if (cfile) {
  const rows = parseRows(readFileSync(`${DIR}/${cfile}`, 'utf8'));
  const det = new TickDetector();
  for (const [t, p] of Object.entries(CONTROL_PRIOR)) det.setPriorClose(t, p);
  const fired: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.symbol) continue;
    seen.add(r.symbol);
    const c = det.addBar(r.symbol, r.bar);
    if (c) fired.push(`${c.ticker} @ +${c.change_pct.toFixed(0)}% (rv ${c.rel_vol}x)`);
  }
  console.log(`false fires: ${fired.length} / ${seen.size}  (${(fired.length / seen.size * 100).toFixed(0)}%)`);
  fired.forEach((f) => console.log('  ' + f));
}

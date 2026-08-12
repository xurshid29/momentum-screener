import { MomoSetupTracker, type MomoSetupBar } from '../src/services/momo-setup.js';
import type { MacdCurlEvent } from '../src/services/macd-curl.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const T0 = 1_754_000_000;
const bar = (ts: number, o: number, h: number, l: number, c: number, volume = 1_000): MomoSetupBar =>
  ({ closeTs: ts, open: o, high: h, low: l, close: c, volume });
const event = (type: MacdCurlEvent['type'], ts: number, price: number): MacdCurlEvent => ({
  type, ticker: 'TEST', variant: '5m', ts_sec: ts, price,
  line: -0.2, signal_val: -0.1, gap: -0.1, below_zero: true,
  rising_bars: 2, max_gap: 1, above_trend: false, episode: 1, setup_number: 1,
});

function buildReady(): MomoSetupTracker {
  const tr = new MomoSetupTracker();
  const bars = [
    bar(T0 + 300, 100, 103, 99, 102),
    bar(T0 + 600, 102, 108, 101, 107),
    bar(T0 + 900, 107, 115, 106, 114),
    bar(T0 + 1200, 114, 121, 113, 120),
  ];
  bars.forEach((b) => tr.add5mBar('TEST', b));
  tr.onMacdEvent(event('fade', T0 + 1200, 120));
  tr.add5mBar('TEST', bar(T0 + 1500, 120, 120, 111, 112, 1_400));
  tr.add5mBar('TEST', bar(T0 + 1800, 112, 113, 107, 108, 900));
  tr.add5mBar('TEST', bar(T0 + 2100, 108, 109, 106.8, 107, 600));
  tr.add5mBar('TEST', bar(T0 + 2400, 107, 108, 106.9, 107.6, 500));
  tr.onMacdEvent(event('setup', T0 + 2400, 107.6));
  return tr;
}

console.log('S1 pullback + base + 5m curl becomes READY');
{
  const tr = buildReady();
  const s = tr.snapshot('TEST')!;
  check('state is ready', s.state === 'ready', `state=${s.state}`);
  check('pullback is measured', (s.pullback_depth_pct ?? 0) >= 10, `depth=${s.pullback_depth_pct}`);
  check('stop is the pullback low', Math.abs((s.stop ?? 0) - 106.8) < 1e-9, `stop=${s.stop}`);
  check('stop distance passes the 15% cap', (s.stop_distance_pct ?? 99) < 15);
  check('setup is numbered', s.setup_number === 1);
}

console.log('S2 2m pivot break needs volume re-expansion');
{
  const tr = buildReady();
  for (let i = 0; i < 5; i++) tr.add2mBar('TEST', bar(T0 + 2500 + i * 120, 107, 107.5 + i * 0.05, 106.8, 107.2, 1_000));
  tr.add2mBar('TEST', bar(T0 + 3100, 107.2, 108.2, 107.1, 108, 1_200));
  check('weak-volume break does not trigger', tr.snapshot('TEST')!.state === 'ready');
  tr.add2mBar('TEST', bar(T0 + 3220, 108, 109.2, 107.9, 109, 2_000));
  const s = tr.snapshot('TEST')!;
  check('strong closed break triggers', s.state === 'triggered', `state=${s.state}`);
  check('entry and trigger are recorded', s.entry === 109 && s.trigger != null);
  check('re-expansion ratio is recorded', (s.volume_reexpansion_ratio ?? 0) >= 1.5);
}

console.log('S3 broken pullback low fails the setup');
{
  const tr = buildReady();
  tr.add5mBar('TEST', bar(T0 + 2700, 107.5, 108, 105, 105.5, 800));
  const s = tr.snapshot('TEST')!;
  check('state is failed', s.state === 'failed', `state=${s.state}`);
  check('failure reason is explicit', s.failure_reason === 'pullback low broke');
}

console.log('S4 silent seed builds context but never invents a lifecycle');
{
  const tr = new MomoSetupTracker();
  for (let i = 0; i < 10; i++) tr.add5mBar('TEST', bar(T0 + i * 300, 100, 101, 99, 100, 500), true);
  check('seed remains warming', tr.snapshot('TEST')?.state === 'warming');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');

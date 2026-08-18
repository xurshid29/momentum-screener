// Focused deterministic check for the Edge state machine. Run with:
//   npx tsx scripts/verify-edge.ts

import assert from 'node:assert/strict';
import { EdgeTracker, type EdgeBar, type EdgeEvent } from '../apps/api/src/services/edge-tracker.js';

const events: EdgeEvent[] = [];
const config = {
  user_id: 'test-user', ticker: 'TEST', ema_fast: 5, ema_slow: 20,
  proximity_pct: 0.75, stop_buffer_pct: 0.5,
  alert_armed: true, alert_entry: true, alert_bailout: true,
  telegram_enabled: false, active: true,
};
const tracker = new EdgeTracker(config, (event) => events.push(event));

const start = Math.floor(Date.parse('2026-08-17T13:30:00Z') / 1000);
let index = 0;
let prior = 10;
function bar(close: number): EdgeBar {
  const open = prior;
  const out = {
    ts_sec: start + (++index * 60),
    open,
    high: Math.max(open, close) + 0.02,
    low: Math.min(open, close) - 0.02,
    close,
    volume: 1_000,
  };
  prior = close;
  return out;
}

tracker.seed(Array.from({ length: 40 }, () => bar(10)));
assert.equal(tracker.snapshot().state, 'watching');
assert.equal(tracker.snapshot().warmup_remaining, 0);
tracker.updateLive(10.002, 9.998, 10.004, start + (index * 60) + 1);
assert.equal(events.at(-1)?.event, 'armed');
assert.equal(tracker.snapshot().state, 'armed');

for (const close of [9.8, 9.6, 9.4, 9.2, 9.25, 9.35, 9.5, 9.7, 9.9, 10.1, 10.3]) {
  tracker.addClosedBar(bar(close));
}
const entry = events.find((event) => event.event === 'entry');
assert.ok(entry, 'recovery through the EMA/VWAP stack should produce an entry');
assert.ok(entry.setup, 'the confirmed entry should carry its bounce/reclaim classification');
assert.ok(entry.bailout != null && entry.bailout > 0);
assert.equal(tracker.snapshot().state, 'entry');

// Changing delivery switches must not erase an in-flight trade or its stop.
tracker.updateConfig({ ...config, alert_armed: false });
assert.equal(tracker.snapshot().state, 'entry');
assert.equal(tracker.snapshot().bailout_level, entry.bailout);

tracker.addClosedBar(bar(entry.bailout! - 0.1));
assert.equal(events.at(-1)?.event, 'bailout');
assert.equal(tracker.snapshot().state, 'bailout');

// VWAP and trade state reset at the next 04:00 ET session while EMA/MACD
// remain continuous.
tracker.addClosedBar({
  ts_sec: Math.floor(Date.parse('2026-08-18T08:01:00Z') / 1000),
  open: 10, high: 10.1, low: 9.9, close: 10, volume: 1_000,
});
assert.equal(tracker.snapshot().state, 'watching');

tracker.reset();
assert.equal(tracker.snapshot().state, 'watching');

console.log(`Edge verification passed: ${events.map((event) => `${event.event}:${event.setup}`).join(' → ')}`);

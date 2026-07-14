// Durable tier-transition recorder — mirrors the poller's graded console.log
// lines (🤫 accum / 👀🛰️ tick / 📰 radar) into the tier_events table so
// precision grading is a SQL query over any date range instead of a grep over
// docker logs that reset on every deploy (2026-07-07: four deploys erased the
// day's evidence four times).
//
// Fire-and-forget by design: an insert failure must never disturb the poll
// cycle — it logs once per burst and moves on.

import { getDb } from '../db/index.js';

let lastErrorLogMs = 0;

export function recordTierEvent(
  tier: 'accum' | 'tick' | 'radar' | 'cross',
  event: string,
  ticker: string,
  meta?: Record<string, unknown>,
): void {
  void getDb()
    .insertInto('tier_events')
    .values({
      tier,
      event,
      ticker,
      meta: meta ? (JSON.stringify(meta) as unknown as never) : null,
    })
    .execute()
    .catch((err) => {
      const now = Date.now();
      if (now - lastErrorLogMs > 60_000) {
        lastErrorLogMs = now;
        console.error('[tier-events] insert failed (continuing):', err instanceof Error ? err.message : err);
      }
    });
}

// TickFeedService — the live "first detector" that runs ahead of the 20s
// Finviz poll. Owns the Python sidecar (Databento EQUS.MINI ohlcv-1s; see
// sidecar/tickfeed.py), feeds its per-second bars to the pure TickDetector,
// and hands any ignition candidate to the poller's alert path. Single-instance,
// like the other background services. OFF unless TICKFEED_ENABLED=true.
//
// The watched symbol set is the structural universe (UniverseService) — already
// the low-float / low-price candidate list — so a detected surge is inherently
// low-float; no per-candidate float gate needed. Prior closes come from the
// same universe fetch (no extra Finviz calls). See docs + the tick-feed memory.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TickDetector, type TickBar } from './tick-detect.js';
import { universe } from './universe.js';
import { poller } from './poller.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TICKFEED = {
  enabled: process.env.TICKFEED_ENABLED === 'true',
  python: process.env.TICKFEED_PYTHON ?? 'python3',
  // sidecar lives at apps/api/sidecar/tickfeed.py; this file is dist/services or
  // src/services, so resolve up to the api root either way.
  sidecar: resolve(__dirname, '..', '..', 'sidecar', 'tickfeed.py'),
  sync_interval_ms: 10 * 60 * 1000, // re-send universe symbols + reseed prior closes
  initial_delay_ms: 30_000,         // let the universe populate before first SUB
  restart_delay_ms: 5_000,
};

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

class TickFeedService {
  private detector = new TickDetector();
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private running = false;
  private etDate = etDate();
  private lastBarAt = 0;
  private barsSeen = 0;
  private candidates = 0;
  private lastError: string | null = null;

  status() {
    return {
      enabled: TICKFEED.enabled,
      running: this.running,
      symbols_tracked: this.detector.symbolsTracked(),
      bars_seen: this.barsSeen,
      candidates: this.candidates,
      last_bar_age_s: this.lastBarAt ? Math.round((Date.now() - this.lastBarAt) / 1000) : null,
      last_error: this.lastError,
    };
  }

  start(): void {
    if (!TICKFEED.enabled) {
      console.log('[tickfeed] disabled (set TICKFEED_ENABLED=true to enable)');
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log('[tickfeed] starting');
    this.spawnSidecar();
    setTimeout(() => this.sync(), TICKFEED.initial_delay_ms);
    this.syncTimer = setInterval(() => this.sync(), TICKFEED.sync_interval_ms);
  }

  stop(): void {
    this.running = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.rl?.close();
    this.child?.kill();
    this.child = null;
  }

  private spawnSidecar(): void {
    try {
      const child = spawn(TICKFEED.python, [TICKFEED.sidecar], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;
      this.rl = createInterface({ input: child.stdout });
      this.rl.on('line', (line) => this.onBar(line));
      child.stderr.on('data', (b) => process.stderr.write(`[tickfeed.py] ${b}`));
      child.on('exit', (code) => {
        console.error(`[tickfeed] sidecar exited (code ${code}) — restarting`);
        this.child = null;
        if (this.running) setTimeout(() => this.spawnSidecar(), TICKFEED.restart_delay_ms);
      });
      console.log(`[tickfeed] sidecar spawned: ${TICKFEED.python} ${TICKFEED.sidecar}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[tickfeed] failed to spawn sidecar:', this.lastError);
    }
  }

  // Push the current universe symbols to the sidecar (additive subscribe) and
  // reseed prior closes. Also handles the midnight-ET session roll.
  private sync(): void {
    const today = etDate();
    if (today !== this.etDate) {
      this.etDate = today;
      this.detector.reset();
      // Fresh Databento session for the new day.
      this.child?.kill();
      console.log('[tickfeed] midnight ET — detector reset, sidecar will respawn');
    }
    const priors = universe.getPriorCloses();
    for (const [t, c] of priors) this.detector.setPriorClose(t, c);
    const syms = Array.from(universe.getUniverse());
    if (syms.length > 0 && this.child?.stdin.writable) {
      this.child.stdin.write(`SUB ${syms.join(',')}\n`);
      console.log(`[tickfeed] synced ${syms.length} symbols, ${priors.size} prior closes`);
    }
  }

  private onBar(line: string): void {
    let m: { t: number; s: string; o: number; h: number; l: number; c: number; v: number };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m.s !== 'string' || typeof m.c !== 'number') return;
    this.barsSeen++;
    this.lastBarAt = Date.now();
    const bar: TickBar = { ts_sec: m.t, close: m.c, high: m.h, low: m.l, volume: m.v };
    const cand = this.detector.addBar(m.s, bar);
    if (cand) {
      this.candidates++;
      poller.onTickCandidate(cand);
    }
    // Surface near-miss reasons (gapped vs which gate) so the rollout is
    // debuggable — why a moving name didn't fire.
    const diag = this.detector.drainDiagnostics();
    for (const d of diag) console.log(`[tickfeed] near-miss: ${d}`);
  }
}

export const tickfeed = new TickFeedService();

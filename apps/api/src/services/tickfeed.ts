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
  // Fast additive sync of the CURRENT screener rows (momentum + ignition). The
  // structural universe refreshes only every 10 min, so a name that starts
  // running before it's in the universe used to wait up to 10 min just to get
  // subscribed — by which point it had no quiet baseline ("0 quiet" gapper).
  screen_sync_interval_ms: 30_000,
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
  private screenSyncTimer: NodeJS.Timeout | null = null;
  private running = false;
  private etDate = etDate();
  private lastBarAt = 0;
  private barsSeen = 0;
  private watches = 0;
  private candidates = 0;   // confirms (kept as `candidates` for /health continuity)
  private fades = 0;
  private lastError: string | null = null;
  // Screener-row symbols subscribed OUTSIDE the structural universe (fast-sync
  // path). Re-SUBbed alongside the universe so sidecar respawns keep them.
  private extraSubs = new Set<string>();
  // AH rows with a daily-close lookup in flight — dedupes the 30s sync ticks.
  private pendingPrior = new Set<string>();

  status() {
    return {
      enabled: TICKFEED.enabled,
      running: this.running,
      symbols_tracked: this.detector.symbolsTracked(),
      bars_seen: this.barsSeen,
      watches: this.watches,
      candidates: this.candidates,
      fades: this.fades,
      extra_subs: this.extraSubs.size,
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
    this.screenSyncTimer = setInterval(() => this.syncScreenRows(), TICKFEED.screen_sync_interval_ms);
  }

  stop(): void {
    this.running = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.screenSyncTimer) clearInterval(this.screenSyncTimer);
    this.screenSyncTimer = null;
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
      child.stderr.on('data', (b) => {
        const s = String(b);
        process.stderr.write(`[tickfeed.py] ${s}`);
        // Surface real errors to /health so a wedged feed isn't silently shown
        // as "running" (the 2026-06-22 Databento connection-limit incident,
        // where bars_seen sat at 0 for ~21h with last_error null).
        if (/error|bentoerror|connection limit|traceback/i.test(s)) {
          this.lastError = s.replace(/\s+/g, ' ').trim().slice(0, 300);
        }
      });
      child.on('exit', (code) => {
        console.error(`[tickfeed] sidecar exited (code ${code}) — restarting`);
        this.child = null;
        if (this.running) setTimeout(() => this.spawnSidecar(), TICKFEED.restart_delay_ms);
      });
      console.log(`[tickfeed] sidecar spawned: ${TICKFEED.python} ${TICKFEED.sidecar}`);
      // Re-send the universe shortly after every spawn (incl. respawns) so a
      // restarted sidecar gets its SUB promptly instead of waiting for the
      // 10-min sync timer and tripping its own 120s no-symbols exit. On the
      // very first spawn the universe is usually still empty here — the +30s
      // initial sync covers that; this matters for respawns.
      setTimeout(() => { if (this.running && this.child === child) this.sync(); }, 3000);
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
      this.extraSubs.clear();
      // Fresh Databento session for the new day.
      this.child?.kill();
      console.log('[tickfeed] midnight ET — detector reset, sidecar will respawn');
    }
    const priors = universe.getPriorCloses();
    for (const [t, c] of priors) this.detector.setPriorClose(t, c);
    const syms = Array.from(new Set([...universe.getUniverse(), ...this.extraSubs]));
    if (syms.length > 0 && this.child?.stdin.writable) {
      this.subscribe(syms);
      console.log(`[tickfeed] synced ${syms.length} symbols (${this.extraSubs.size} extra), ${priors.size} prior closes`);
    }
  }

  // Fast additive sync: subscribe the CURRENT screener rows (momentum +
  // ignition) the moment they appear, instead of waiting for the 10-min
  // universe refresh. Prior close is derived from the row itself
  // (price / (1 + change%/100)) — skipped in after-hours, where row
  // change/price are the AH overlay (anchored to today's close, not the prior
  // one) and would corrupt the detector's cum% measurement.
  // Also arms NEWS RADAR names (payload.news_radar): a fresh catalyst on a
  // known runner that isn't moving yet — subscribing NOW means the watch/
  // confirm machine is already listening when the move starts. Radar entries
  // carry a daily_bars prior close, which is session-independent.
  private syncScreenRows(): void {
    const payload = poller.getLastPayload();
    if (!payload || payload.session === 'closed') return;
    const fresh: string[] = [];
    if (payload.session !== 'afterhours') {
      for (const r of [...payload.rows, ...payload.ignition]) {
        const tk = r.ticker.toUpperCase();
        if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) continue;
        if (r.price == null || r.change_pct == null || r.price <= 0 || r.change_pct <= -100) continue;
        this.detector.setPriorClose(tk, r.price / (1 + r.change_pct / 100));
        this.extraSubs.add(tk);
        fresh.push(tk);
      }
    } else {
      // After-hours: row change/price are the AH overlay (anchored to TODAY's
      // close), so deriving a prior from them is wrong. Anchor on the latest
      // stored daily close instead — same as news-radar arming. Without this,
      // an AH runner outside the structural universe (whose membership is
      // frozen after 4pm) stays invisible to the detector for its entire run
      // (UPC 2026-07-02: on Momentum at 16:03 ET, first tick bar 16:33).
      for (const r of [...payload.rows, ...payload.ignition]) {
        const tk = r.ticker.toUpperCase();
        if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk) || this.pendingPrior.has(tk)) continue;
        this.pendingPrior.add(tk);
        void poller.lookupPriorClose(tk).then((pc) => {
          this.pendingPrior.delete(tk);
          if (pc == null || pc <= 0) return;
          if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) return;
          this.detector.setPriorClose(tk, pc);
          this.extraSubs.add(tk);
          this.subscribe([tk]);
          console.log(`[tickfeed] screen-sync (AH) — subscribed ${tk} (daily close $${pc})`);
        });
      }
    }
    for (const n of payload.news_radar ?? []) {
      const tk = n.ticker.toUpperCase();
      if (this.detector.hasPriorClose(tk) || this.extraSubs.has(tk)) continue;
      if (n.prior_close == null || n.prior_close <= 0) continue;
      this.detector.setPriorClose(tk, n.prior_close);
      this.extraSubs.add(tk);
      fresh.push(tk);
    }
    if (fresh.length > 0 && this.child?.stdin.writable) {
      this.subscribe(fresh);
      console.log(`[tickfeed] screen-sync — subscribed ${fresh.length} names: ${fresh.join(',')}`);
    }
  }

  private subscribe(syms: string[]): void {
    if (!this.child?.stdin.writable) return;
    // Chunk into modest SUB lines — a single 3000+-symbol line risked being
    // split across the sidecar's stdin reads ("unknown command: …"). Each
    // line is a complete, newline-terminated SUB it can parse independently.
    const CHUNK = 400;
    for (let i = 0; i < syms.length; i += CHUNK) {
      this.child.stdin.write(`SUB ${syms.slice(i, i + CHUNK).join(',')}\n`);
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
    if (this.lastError) this.lastError = null; // bars flowing again — clear the stale error
    const bar: TickBar = { ts_sec: m.t, close: m.c, high: m.h, low: m.l, volume: m.v };
    const ev = this.detector.addBar(m.s, bar);
    if (ev) {
      if (ev.type === 'watch') this.watches++;
      else if (ev.type === 'confirm') this.candidates++;
      else this.fades++;
      poller.onTickEvent(ev);
    }
    // Surface near-miss reasons (gapped vs which gate) so the rollout is
    // debuggable — why a moving name didn't fire.
    const diag = this.detector.drainDiagnostics();
    for (const d of diag) console.log(`[tickfeed] near-miss: ${d}`);
  }
}

export const tickfeed = new TickFeedService();

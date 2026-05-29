// TelegramBotService — the inbound side of the bot. Listens for commands via
// long-poll `getUpdates`, dispatches them against the live poller payload, and
// replies. One-way alerts (poller → chat) and two-way commands (chat ⇄ bot)
// share the same bot/token; this service strictly answers commands.
//
// Auth model: only messages from the configured TELEGRAM_CHAT_ID get a reply.
// Other senders are silently ignored. Same security posture as the alerts —
// it's a personal/team bot with a single trusted chat.

import { getDb } from '../db/index.js';
import { poller } from './poller.js';
import { universe } from './universe.js';
import { shelf } from './shelf.js';
import {
  escapeHtml,
  getUpdates,
  sendTelegram,
  setBotCommands,
  telegramEnabled,
  type TelegramUpdate,
} from './telegram.js';
import type { EnrichedRow, IgnitionRow, SwingRow } from './poller.js';

class TelegramBotService {
  private running = false;
  private updateOffset = 0;
  private commandsHandled = 0;
  private lastError: string | null = null;
  private lastCommandAt: Date | null = null;

  status() {
    return {
      running: this.running,
      offset: this.updateOffset,
      commands_handled: this.commandsHandled,
      last_command_at: this.lastCommandAt?.toISOString() ?? null,
      last_error: this.lastError,
    };
  }

  start(): void {
    if (this.running) return;
    if (!telegramEnabled()) {
      console.log('[telegram-bot] not started — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset');
      return;
    }
    this.running = true;
    console.log('[telegram-bot] starting (long-poll loop)');
    // Populate the / menu in the Telegram client. Fire-and-forget; cosmetic.
    void setBotCommands([
      { command: 'ignition', description: 'Current Ignition list' },
      { command: 'momentum', description: 'Current Momentum list' },
      { command: 'swing', description: 'Current Swing list' },
      { command: 'status', description: 'Poller status' },
      { command: 'ticker', description: 'Quick stats for a ticker' },
      { command: 'hidden', description: 'List hidden tickers' },
      { command: 'unhide', description: 'Restore a hidden ticker' },
      { command: 'alerts', description: 'Pause or resume alerts' },
      { command: 'help', description: 'Show commands' },
    ]);
    void this.run();
  }

  stop(): void {
    this.running = false;
  }

  // Long-poll loop. Each iteration blocks up to LONG_POLL_TIMEOUT_S on the
  // Telegram side, returning immediately if updates arrive. Errors back off
  // for 10s so a flaky API doesn't busy-loop.
  private async run(): Promise<void> {
    while (this.running) {
      try {
        const updates = await getUpdates(this.updateOffset);
        for (const u of updates) {
          this.updateOffset = Math.max(this.updateOffset, u.update_id + 1);
          await this.handleUpdate(u);
        }
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error('[telegram-bot] loop error:', err);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  private async handleUpdate(u: TelegramUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text || !msg.chat) return;
    // Single-chat auth — anything else is silently dropped.
    if (String(msg.chat.id) !== process.env.TELEGRAM_CHAT_ID) return;

    const text = msg.text.trim();
    if (!text.startsWith('/')) return;
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    // Strip the @botname suffix that group-chat commands carry.
    const command = cmd.toLowerCase().split('@')[0];

    this.lastCommandAt = new Date();
    try {
      const reply = await dispatch(command, args);
      if (reply) await sendTelegram(reply, { disableNotification: true });
      this.commandsHandled++;
    } catch (err) {
      const msg2 = err instanceof Error ? err.message : String(err);
      this.lastError = msg2;
      console.error('[telegram-bot] command error:', err);
      await sendTelegram(`⚠️ Error: ${escapeHtml(msg2)}`, { disableNotification: true });
    }
  }
}

export const telegramBot = new TelegramBotService();

// ────────────────────────────────────────────────────────────────────────────
// Command dispatch + formatters
// ────────────────────────────────────────────────────────────────────────────

async function dispatch(cmd: string, args: string[]): Promise<string | null> {
  switch (cmd) {
    case 'start':
    case 'help':
      return formatHelp();
    case 'ignition':
    case 'ig':
      return formatIgnitionList(parseN(args[0], 15));
    case 'momentum':
    case 'mom':
      return formatMomentumList(parseN(args[0], 15));
    case 'swing':
    case 'sw':
      return formatSwingList(parseN(args[0], 15));
    case 'status':
      return formatStatus();
    case 'ticker':
    case 't':
      return formatTicker(args[0]);
    case 'hidden':
      return formatHidden();
    case 'unhide':
      return formatUnhide(args[0]);
    case 'alerts':
      return formatAlertsToggle(args[0]);
    default:
      return 'Unknown command. Try <b>/help</b>.';
  }
}

function parseN(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, 30);
}

function validTicker(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.toUpperCase();
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(t) ? t : null;
}

function formatHelp(): string {
  return [
    '🤖 <b>Commands</b>',
    '',
    '<b>/ignition</b> [N] · current Ignition list (default 15)',
    '<b>/momentum</b> [N] · current Momentum list',
    '<b>/swing</b> [N] · current Swing list',
    '<b>/status</b> · poller status',
    '<b>/ticker</b> SYMBOL · quick stats for one ticker',
    '<b>/hidden</b> · list hidden tickers',
    '<b>/unhide</b> SYMBOL · restore a hidden ticker',
    '<b>/alerts</b> on|off · pause or resume alerts',
    '',
    '<i>Short forms:</i> /ig /mom /sw /t',
  ].join('\n');
}

function etTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

function etDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function catalystGlyph(direction: string | undefined): string {
  if (direction === 'bullish') return '🔥';
  if (direction === 'bearish') return '🔻';
  return '◆';
}

function shelfGlyph(level: string | undefined): string {
  if (level === 'active') return '🔴';
  if (level === 'effective') return '⚠️';
  if (level === 'shelf') return '📄';
  return '';
}

function formatIgnitionList(n: number): string {
  const p = poller.getLastPayload();
  if (!p) return 'No cycle yet — poller is starting up.';
  if (p.ignition.length === 0) return 'No ignitions in the current cycle.';
  const rows = p.ignition.slice(0, n);
  const header = `⚡ <b>Ignition</b> (${p.ignition.length}) · ${etTimeShort(p.polled_at)} ET · ${p.session}`;
  return [header, '', ...rows.map(formatIgnitionLine)].join('\n');
}

function formatIgnitionLine(r: IgnitionRow): string {
  const mark = r.is_new ? '🆕' : '·';
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(0)}%`;
  const float = r.float_m == null ? '' : `${r.float_m.toFixed(1)}M`;
  const rv5 = r.rel_vol_5min == null ? '—' : `${Math.round(r.rel_vol_5min)}%`;
  const cat = r.catalyst ? ` ${catalystGlyph(r.catalyst.direction)}${r.catalyst.score}` : '';
  const sh = r.shelf ? ` ${shelfGlyph(r.shelf.level)}` : '';
  return `${mark} <b>${escapeHtml(r.ticker)}</b> ${r.runner_score}  ${price}  ${chg}  ${float}·${rv5}${cat}${sh}`;
}

function formatMomentumList(n: number): string {
  const p = poller.getLastPayload();
  if (!p) return 'No cycle yet — poller is starting up.';
  if (p.rows.length === 0) return 'No Momentum rows in the current cycle.';
  const rows = p.rows.slice(0, n);
  const header = `🚀 <b>Momentum</b> (${p.rows.length}) · ${etTimeShort(p.polled_at)} ET · ${p.session}`;
  return [header, '', ...rows.map(formatMomentumLine)].join('\n');
}

function formatMomentumLine(r: EnrichedRow): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const float = r.float_m == null ? '' : `${r.float_m.toFixed(1)}M`;
  const rvol = r.rel_volume == null ? '' : `${Math.round(r.rel_volume)}x`;
  const cat = r.catalyst && r.catalyst.urgency !== 'ignore'
    ? ` ${catalystGlyph(r.catalyst.direction)}${r.catalyst.urgency}`
    : '';
  const sh = r.shelf ? ` ${shelfGlyph(r.shelf.level)}` : '';
  const status = r.status ? ` ${r.status}` : '';
  return `<b>${escapeHtml(r.ticker)}</b> ${chg}  ${price}  ${float}·${rvol}${cat}${sh}${status}`;
}

function formatSwingList(n: number): string {
  const p = poller.getLastPayload();
  if (!p) return 'No cycle yet — poller is starting up.';
  if (!p.swing || p.swing.length === 0) {
    return 'No Swing candidates yet. The first scan runs at startup, then every ~20 min; daily-bar backfill seeds the score.';
  }
  const rows = p.swing.slice(0, n);
  const header = `📊 <b>Swing</b> (${p.swing.length}) · ${etTimeShort(p.polled_at)} ET · ${p.session}`;
  return [header, '', ...rows.map(formatSwingLine)].join('\n');
}

// Compact one-liner for the /swing list. Setup flags ride as a tiny glyph
// strip (📦 base · ↑10 / ↑5 breakout · ⬆ close-strength); vs-52WH gives the
// "near the highs?" eyeball.
function formatSwingLine(r: SwingRow): string {
  const price = r.price == null ? '' : `$${r.price.toFixed(2)}`;
  const chg = r.change_pct == null ? '' : `${r.change_pct >= 0 ? '+' : ''}${r.change_pct.toFixed(1)}%`;
  const dist = r.daily_context.dist_52w_high_pct;
  const distTxt = dist == null ? '' : ` 52WH${dist >= 0 ? '+' : ''}${dist.toFixed(0)}%`;
  const flags = [
    r.setup_flags.in_base ? '📦' : '',
    r.setup_flags.broke_out ? '↑10' : r.setup_flags.broke_out_5d ? '↑5' : '',
    r.setup_flags.close_in_top_q ? '⬆' : '',
  ].filter(Boolean).join('');
  const flagsStr = flags ? ` ${flags}` : '';
  const cat = r.catalyst && r.catalyst.urgency !== 'ignore'
    ? ` ${catalystGlyph(r.catalyst.direction)}${r.catalyst.score}`
    : '';
  const sh = r.shelf ? ` ${shelfGlyph(r.shelf.level)}` : '';
  return `<b>${escapeHtml(r.ticker)}</b> ${r.swing_score}  ${price}  ${chg}${distTxt}${flagsStr}${cat}${sh}`;
}

function formatStatus(): string {
  const p = poller.getLastPayload();
  const ps = poller.status();
  const ss = shelf.status();
  const us = universe.status();
  const muted = poller.areAlertsMuted();
  return [
    '🤖 <b>Status</b>',
    '',
    `Poller: ${ps.running ? '✅ running' : '❌ stopped'} · ${ps.session ?? '—'} · cycle ${etTimeShort(p?.polled_at)} ET`,
    `Rows: ${p?.rows.length ?? 0} momentum · ${p?.ignition.length ?? 0} ignition · ${p?.swing.length ?? 0} swing`,
    `Tracked: ${ps.tracked_tickers} · Universe: ${us.ticker_count}`,
    `Shelf cache: ${ss.cached} (${ss.queued} queued)`,
    `Alerts: ${muted ? '🔇 muted' : '🔔 enabled'}`,
  ].join('\n');
}

function formatTicker(arg: string | undefined): string {
  const ticker = validTicker(arg);
  if (!ticker) return 'Usage: <code>/ticker SYMBOL</code>';
  const p = poller.getLastPayload();
  if (!p) return 'No cycle yet — poller is starting up.';
  const row =
    p.rows.find((r) => r.ticker === ticker) ??
    p.ignition.find((r) => r.ticker === ticker) ??
    p.swing?.find((r) => r.ticker === ticker);
  if (!row) return `<b>${escapeHtml(ticker)}</b> not in the current screener.`;

  const price = row.price == null ? '—' : `$${row.price.toFixed(2)}`;
  const chg = row.change_pct == null
    ? '—'
    : `${row.change_pct >= 0 ? '+' : ''}${row.change_pct.toFixed(2)}%`;
  const sub = [row.company, row.country, row.industry].filter(Boolean).join(' · ');
  const stats = [
    row.float_m != null ? `float ${row.float_m.toFixed(1)}M` : null,
    row.mcap_m != null ? `mcap ${Math.round(row.mcap_m)}M` : null,
    row.rel_volume != null ? `rvol ${Math.round(row.rel_volume)}x` : null,
    row.rel_vol_5min != null ? `rv5 ${Math.round(row.rel_vol_5min)}%` : null,
    row.short_float_pct != null ? `short ${row.short_float_pct.toFixed(1)}%` : null,
  ].filter(Boolean).join(' · ');
  const cat = row.catalyst
    ? `${catalystGlyph(row.catalyst.direction)} <b>${row.catalyst.urgency}</b> · score ${row.catalyst.score} · ${escapeHtml(row.catalyst.type)}`
    : '';
  const newsline = row.news_title ? `“${escapeHtml(row.news_title)}”` : '';
  const sh = row.shelf
    ? `⚠️ ${row.shelf.level === 'active' ? 'ACTIVE OFFERING' : row.shelf.level === 'effective' ? 'EFFECTIVE SHELF' : 'SHELF ON FILE'} — ${escapeHtml(row.shelf.latest_form)}, ${row.shelf.days_since}d ago`
    : '';
  const finviz = `https://elite.finviz.com/quote?t=${encodeURIComponent(ticker)}&ty=c&p=h&b=1`;
  const tv = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(ticker)}`;
  const links = `<a href="${finviz}">Finviz</a> · <a href="${tv}">TradingView</a>`;
  return [
    `<b>${escapeHtml(ticker)}</b>  ${price}  ${chg}`,
    sub ? escapeHtml(sub) : null,
    stats,
    cat,
    newsline,
    sh,
    links,
  ].filter(Boolean).join('\n');
}

async function formatHidden(): Promise<string> {
  const userId = process.env.TELEGRAM_USER_ID?.trim();
  if (!userId) {
    return 'Hidden-list commands need <code>TELEGRAM_USER_ID</code> in <code>.env</code> — the dashboard user the bot acts as. Look it up with <code>select id, username from users;</code>.';
  }
  try {
    const today = etDateString();
    const rows = await getDb()
      .selectFrom('user_hidden_tickers')
      .select('ticker')
      .where('user_id', '=', userId)
      .where('hidden_date', '=', today)
      .execute();
    if (rows.length === 0) return '🙈 No hidden tickers today.';
    const list = rows.map((r) => `<b>${escapeHtml(r.ticker)}</b>`).join(' · ');
    return [
      `🙈 <b>Hidden today</b> (${rows.length})`,
      list,
      '',
      'Use <code>/unhide SYMBOL</code> to restore.',
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to fetch hidden list: ${escapeHtml(msg)}`;
  }
}

async function formatUnhide(arg: string | undefined): Promise<string> {
  const ticker = validTicker(arg);
  if (!ticker) return 'Usage: <code>/unhide SYMBOL</code>';
  const userId = process.env.TELEGRAM_USER_ID?.trim();
  if (!userId) {
    return 'Hidden-list commands need <code>TELEGRAM_USER_ID</code> in <code>.env</code>.';
  }
  try {
    const today = etDateString();
    const result = await getDb()
      .deleteFrom('user_hidden_tickers')
      .where('user_id', '=', userId)
      .where('ticker', '=', ticker)
      .where('hidden_date', '=', today)
      .executeTakeFirst();
    if (Number(result.numDeletedRows ?? 0) === 0) {
      return `<b>${escapeHtml(ticker)}</b> isn't on today's hidden list.`;
    }
    return `✅ Unhidden <b>${escapeHtml(ticker)}</b>.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed: ${escapeHtml(msg)}`;
  }
}

function formatAlertsToggle(arg: string | undefined): string {
  if (!arg) {
    const muted = poller.areAlertsMuted();
    return `Alerts: ${muted ? '🔇 muted' : '🔔 enabled'}\nUse <code>/alerts on</code> or <code>/alerts off</code>.`;
  }
  const a = arg.toLowerCase();
  if (a === 'on' || a === 'resume' || a === 'enable' || a === 'unmute') {
    poller.setAlertsMuted(false);
    return '🔔 Alerts resumed.';
  }
  if (a === 'off' || a === 'pause' || a === 'mute' || a === 'disable') {
    poller.setAlertsMuted(true);
    return '🔇 Alerts muted (resets on API restart, or use <code>/alerts on</code>).';
  }
  return 'Usage: <code>/alerts on</code> or <code>/alerts off</code>';
}

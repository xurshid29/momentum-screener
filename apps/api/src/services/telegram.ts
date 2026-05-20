// Telegram Bot API client — pushes screener alerts to a chat so they reach the
// user 24/5, independent of whether a browser dashboard is open. No-ops cleanly
// when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset. Also exposes the
// long-poll getUpdates helper the TelegramBotService uses to receive commands.

const TIMEOUT_MS = 6000;

export function telegramEnabled(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Escape text for Telegram's HTML parse mode — only & < > are special, and the
// same escaping makes a URL safe to drop into an <a href="…"> attribute.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface SendOptions {
  // Quiet send — for command replies. Alerts default to a noisy push so the
  // chat actually pings on the user's phone.
  disableNotification?: boolean;
}

// Send an HTML-formatted message. Returns false (never throws) on any failure
// so a flaky Telegram call can't disrupt a poll cycle.
export async function sendTelegram(html: string, opts?: SendOptions): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: opts?.disableNotification ?? false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[telegram] sendMessage failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[telegram] send error:', err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── getUpdates — long-polling, for the command bot ────────────────────────
// Telegram supports HTTP long-polling: the server holds the request open until
// new updates arrive or `timeout` elapses. One outstanding request at idle, a
// few per minute when busy — well under the rate limit.

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
    date: number;
  };
}

const LONG_POLL_TIMEOUT_S = 25;

export async function getUpdates(
  offset: number,
  timeoutSec = LONG_POLL_TIMEOUT_S,
): Promise<TelegramUpdate[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return [];

  const ctrl = new AbortController();
  // Allow a few seconds of slack over the long-poll timeout so the server has
  // a chance to respond before fetch aborts.
  const timer = setTimeout(() => ctrl.abort(), (timeoutSec + 5) * 1000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message'],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.error(`[telegram] getUpdates failed: HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return json.ok && Array.isArray(json.result) ? json.result : [];
  } catch (err) {
    // Abort = long-poll naturally expired; not an error.
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.error('[telegram] getUpdates error:', err);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// One-time call at bot startup to populate the / menu in the Telegram client.
// Never throws — a failure here is cosmetic.
export async function setBotCommands(
  commands: { command: string; description: string }[],
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
  } catch (err) {
    console.error('[telegram] setMyCommands failed:', err);
  }
}

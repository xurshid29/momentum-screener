// Telegram Bot API client — pushes screener alerts to a chat so they reach the
// user 24/5, independent of whether a browser dashboard is open. No-ops cleanly
// when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.

const TIMEOUT_MS = 6000;

export function telegramEnabled(): boolean {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Escape text for Telegram's HTML parse mode — only & < > are special, and the
// same escaping makes a URL safe to drop into an <a href="…"> attribute.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Send an HTML-formatted message. Returns false (never throws) on any failure
// so a flaky Telegram call can't disrupt a poll cycle.
export async function sendTelegram(html: string): Promise<boolean> {
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

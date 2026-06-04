import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env') });

import express from 'express';
import cors from 'cors';
import { checkConnection } from './db/index.js';
import authRouter from './routes/auth.js';
import screenerRouter from './routes/screener.js';
import newsRouter from './routes/news.js';
import prefsRouter from './routes/prefs.js';
import { poller } from './services/poller.js';
import { universe } from './services/universe.js';
import { shelf } from './services/shelf.js';
import { dailyBars } from './services/daily-bars.js';
import { outcomes } from './services/outcomes.js';
import { telegramBot } from './services/telegram-bot.js';

// Safety net: an unhandled promise rejection in any async route (e.g. a bad
// query) would otherwise crash the whole process — taking down the poller and
// its in-memory cross-cycle state with it (see the 2026-06-04 flagged-tickers
// empty-SET crash). Log and keep running; a single bad request should degrade
// that request, not the service. uncaughtException is kept fatal-ish (log only)
// since the process may be in an unknown state, but we don't hard-exit.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaughtException:', err);
});

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', async (_req, res) => {
  const dbOk = await checkConnection();
  res.json({
    status: dbOk ? 'ok' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    poller: poller.status(),
    universe: universe.status(),
    shelf: shelf.status(),
    daily_bars: dailyBars.status(),
    outcomes: outcomes.status(),
    telegram_bot: telegramBot.status(),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/screener', screenerRouter);
app.use('/api/news', newsRouter);
app.use('/api/prefs', prefsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`API server running at http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  void poller.start();
  universe.start();
  shelf.start();
  dailyBars.start();
  telegramBot.start();
  // One-time catch-up: backfill outcomes for the existing detection history on
  // boot (the post-close trigger only covers go-forward days). Delayed so the
  // schema/connection are warm and the daily-bars service has begun populating
  // bars. Best-effort — the service swallows its own errors.
  setTimeout(() => void outcomes.computeOutcomes(), 60_000);
});

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
});

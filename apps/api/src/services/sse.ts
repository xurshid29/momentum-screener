import type { Response } from 'express';

// Lightweight SSE broadcaster. One channel ('screener'), one set of subscribers.
// Heartbeats every 25s keep proxies (and Chrome's default idle timeout) happy.

type Client = {
  id: number;
  res: Response;
};

let nextId = 1;
const clients = new Set<Client>();

export function addClient(res: Response): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client: Client = { id: nextId++, res };
  clients.add(client);
  res.write(`: connected\n\n`);

  return () => {
    clients.delete(client);
  };
}

export function broadcast(event: string, payload: unknown): void {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

setInterval(() => {
  for (const client of clients) {
    try {
      client.res.write(`: keepalive\n\n`);
    } catch {
      clients.delete(client);
    }
  }
}, 25_000);

export function clientCount(): number {
  return clients.size;
}

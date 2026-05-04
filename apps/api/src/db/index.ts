import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

const { Pool, types } = pg;

// Postgres returns numeric & bigint as strings by default (preserves precision
// for arbitrary-precision values). For this app — prices, change %, float in
// millions, share counts — JS number precision is fine and the frontend assumes
// numbers. Cast at the driver layer so every consumer sees the right type.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v == null ? null : parseFloat(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v == null ? null : parseInt(v, 10)));

let _db: Kysely<Database> | null = null;

// Lazy initialization to ensure env vars are loaded
export function getDb(): Kysely<Database> {
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    const pool = new Pool({ connectionString });

    _db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
    });
  }
  return _db;
}

// For convenience, export a getter
export const db = {
  get instance() {
    return getDb();
  },
};

// Export types
export * from './types.js';

// Health check
export async function checkConnection(): Promise<boolean> {
  try {
    await getDb().selectFrom('users').select('id').limit(1).execute();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

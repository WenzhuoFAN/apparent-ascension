import { Pool, type QueryResult } from "pg";

const connectionString = String(import.meta.env.DATABASE_URL || process.env.DATABASE_URL || "").trim();

declare global {
  // eslint-disable-next-line no-var
  var __aaPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __aaSchemaReady: Promise<void> | undefined;
}

const isLocalConnection = (url: string) => /localhost|127\.0\.0\.1/i.test(url);

const getPool = () => {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!globalThis.__aaPool) {
    globalThis.__aaPool = new Pool({
      connectionString,
      ssl: isLocalConnection(connectionString) ? undefined : { rejectUnauthorized: false },
    });
  }

  return globalThis.__aaPool;
};

export const ensureSchema = async () => {
  if (!globalThis.__aaSchemaReady) {
    globalThis.__aaSchemaReady = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id BIGSERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token_hash TEXT PRIMARY KEY,
          admin_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
          ON admin_sessions (expires_at);
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS site_content (
          content_key TEXT PRIMARY KEY,
          content_json JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`DELETE FROM admin_sessions WHERE expires_at <= NOW();`);
    })();
  }

  await globalThis.__aaSchemaReady;
};

export const query = async <T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
  await ensureSchema();
  const pool = getPool();
  return pool.query<T>(sql, params);
};


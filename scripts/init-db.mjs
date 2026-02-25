import { Pool } from "pg";

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

try {
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

  console.log("DB schema is ready.");
} finally {
  await pool.end();
}


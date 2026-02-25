import { randomBytes, scrypt as _scrypt } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(_scrypt);
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const username = String(process.argv[2] || "").trim();
const password = String(process.argv[3] || "");

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (!username || !password) {
  console.error("Usage: npm run admin:create -- <username> <password>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/i.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

const hashPassword = async (pwd) => {
  const saltHex = randomBytes(16).toString("hex");
  const hash = (await scrypt(pwd, Buffer.from(saltHex, "hex"), 64)).toString("hex");
  return `scrypt:${saltHex}:${hash}`;
};

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const passwordHash = await hashPassword(password);
  await pool.query(
    `
      INSERT INTO admin_users (username, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (username)
      DO UPDATE SET password_hash = EXCLUDED.password_hash
    `,
    [username, passwordHash],
  );

  console.log(`Admin user '${username}' created/updated.`);
} finally {
  await pool.end();
}


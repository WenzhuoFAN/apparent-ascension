import type { APIContext } from "astro";
import { createHash, randomBytes } from "node:crypto";
import { query } from "./db";

const SESSION_COOKIE = "aa_admin_session";
const SESSION_TTL_DAYS = 30;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const isSecureRequest = (context: APIContext) =>
  context.url.protocol === "https:" || import.meta.env.PROD;

export type AdminSession = {
  adminId: number;
  username: string;
};

export const getAdminSession = async (context: APIContext): Promise<AdminSession | null> => {
  const rawToken = context.cookies.get(SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const result = await query<{ admin_id: string; username: string }>(
    `
      SELECT s.admin_id, u.username
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash],
  );

  if (!result.rowCount) {
    return null;
  }

  const row = result.rows[0];
  return {
    adminId: Number(row.admin_id),
    username: row.username,
  };
};

export const createAdminSession = async (context: APIContext, adminId: number) => {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `
      INSERT INTO admin_sessions (token_hash, admin_id, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (token_hash)
      DO UPDATE SET admin_id = EXCLUDED.admin_id, expires_at = EXCLUDED.expires_at
    `,
    [tokenHash, adminId, expiresAt.toISOString()],
  );

  context.cookies.set(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(context),
    path: "/",
    expires: expiresAt,
  });
};

export const clearAdminSession = async (context: APIContext) => {
  const rawToken = context.cookies.get(SESSION_COOKIE)?.value;
  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    await query(`DELETE FROM admin_sessions WHERE token_hash = $1`, [tokenHash]);
  }

  context.cookies.delete(SESSION_COOKIE, {
    path: "/",
    sameSite: "lax",
    secure: isSecureRequest(context),
  });
};


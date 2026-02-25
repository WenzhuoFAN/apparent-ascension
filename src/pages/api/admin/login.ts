import type { APIRoute } from "astro";
import { createAdminSession } from "../../../lib/admin-auth";
import { query } from "../../../lib/db";
import { verifyPassword } from "../../../lib/password";

type LoginBody = {
  username?: string;
  password?: string;
};

export const POST: APIRoute = async (context) => {
  try {
    const body = (await context.request.json()) as LoginBody;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    if (!username || !password) {
      return new Response(JSON.stringify({ ok: false, message: "用户名和密码不能为空。" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const result = await query<{ id: string; username: string; password_hash: string }>(
      `SELECT id, username, password_hash FROM admin_users WHERE username = $1 LIMIT 1`,
      [username],
    );

    if (!result.rowCount) {
      return new Response(JSON.stringify({ ok: false, message: "账号或密码错误。" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const user = result.rows[0];
    const verified = await verifyPassword(password, user.password_hash);
    if (!verified) {
      return new Response(JSON.stringify({ ok: false, message: "账号或密码错误。" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    await createAdminSession(context, Number(user.id));
    return new Response(JSON.stringify({ ok: true, username: user.username }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
};


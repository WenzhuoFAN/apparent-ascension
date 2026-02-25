import type { APIRoute } from "astro";
import { clearAdminSession } from "../../../lib/admin-auth";

export const POST: APIRoute = async (context) => {
  try {
    await clearAdminSession(context);
    return new Response(JSON.stringify({ ok: true }), {
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


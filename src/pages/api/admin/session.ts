import type { APIRoute } from "astro";
import { getAdminSession } from "../../../lib/admin-auth";

export const GET: APIRoute = async (context) => {
  try {
    const session = await getAdminSession(context);
    return new Response(
      JSON.stringify({
        authenticated: !!session,
        username: session?.username ?? null,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
};


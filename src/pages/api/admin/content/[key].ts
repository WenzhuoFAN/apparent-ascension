import type { APIRoute } from "astro";
import { getAdminSession } from "../../../../lib/admin-auth";
import { ADMIN_MUTABLE_CONTENT_KEYS, getContentByKey, setContentByKey } from "../../../../lib/content-store";

type PutBody = {
  data?: unknown;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export const GET: APIRoute = async (context) => {
  try {
    const session = await getAdminSession(context);
    if (!session) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const key = decodeURIComponent(String(context.params.key || ""));
    if (!ADMIN_MUTABLE_CONTENT_KEYS.has(key)) {
      return new Response(JSON.stringify({ ok: false, message: "Not found" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    const data = await getContentByKey(key);
    return new Response(JSON.stringify({ ok: true, key, data }), {
      status: 200,
      headers: { ...jsonHeaders, "cache-control": "no-store" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: jsonHeaders,
      },
    );
  }
};

export const PUT: APIRoute = async (context) => {
  try {
    const session = await getAdminSession(context);
    if (!session) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const key = decodeURIComponent(String(context.params.key || ""));
    if (!ADMIN_MUTABLE_CONTENT_KEYS.has(key)) {
      return new Response(JSON.stringify({ ok: false, message: "Not found" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    const body = (await context.request.json()) as PutBody;
    const data = await setContentByKey(key, body.data);

    return new Response(JSON.stringify({ ok: true, key, data }), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: jsonHeaders,
      },
    );
  }
};


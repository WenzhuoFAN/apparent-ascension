import type { APIRoute } from "astro";
import { CONTENT_KEYS, PUBLIC_CONTENT_KEYS, getContentByKey } from "../../../lib/content-store";

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

export const GET: APIRoute = async ({ params }) => {
  try {
    const key = decodeURIComponent(String(params.key || ""));
    if (!PUBLIC_CONTENT_KEYS.has(key)) {
      return new Response(JSON.stringify({ ok: false, message: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    let data = await getContentByKey(key);
    if (key === CONTENT_KEYS.notices && Array.isArray(data)) {
      data = data.filter((row) => isObject(row) && row.published === true);
    }
    return new Response(JSON.stringify({ ok: true, key, data }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
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

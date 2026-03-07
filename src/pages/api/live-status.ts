import type { APIRoute } from "astro";
import { LIVE_STATUS_BY_KEY, fetchLiveStatusByMid } from "../../lib/bilibili-live";

type MemberKey = keyof typeof LIVE_STATUS_BY_KEY;

const asMemberKeys = (value: string | null): MemberKey[] => {
  const allKeys = Object.keys(LIVE_STATUS_BY_KEY) as MemberKey[];
  if (!value) return allKeys;

  const selected = value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x): x is MemberKey => x === "fiona" || x === "gladys");

  return selected.length ? selected : allKeys;
};

export const GET: APIRoute = async ({ url }) => {
  const keys = asMemberKeys(url.searchParams.get("members"));

  const entries = await Promise.all(
    keys.map(async (key) => ({
      key,
      status: await fetchLiveStatusByMid(LIVE_STATUS_BY_KEY[key]),
    })),
  );

  const statuses: Record<MemberKey, LiveStatus> = {
    fiona: { live: null, roomId: null, liveUrl: null },
    gladys: { live: null, roomId: null, liveUrl: null },
  };

  entries.forEach(({ key, status }) => {
    statuses[key] = status;
  });

  return new Response(
    JSON.stringify({
      ok: true,
      updatedAt: new Date().toISOString(),
      statuses,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
};

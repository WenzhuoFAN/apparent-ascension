import type { APIRoute } from "astro";

const LIVE_STATUS_BY_KEY = {
  fiona: "3537115310721181",
  gladys: "3537115310721781",
} as const;

type MemberKey = keyof typeof LIVE_STATUS_BY_KEY;
type LiveStatus = {
  live: boolean | null;
  roomId: number | null;
  liveUrl: string | null;
};

const LIVE_STATUS_API = "https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=";

const asMemberKeys = (value: string | null): MemberKey[] => {
  const allKeys = Object.keys(LIVE_STATUS_BY_KEY) as MemberKey[];
  if (!value) return allKeys;

  const selected = value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x): x is MemberKey => x === "fiona" || x === "gladys");

  return selected.length ? selected : allKeys;
};

const fetchLiveStatusByMid = async (mid: string): Promise<LiveStatus> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${LIVE_STATUS_API}${mid}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!response.ok) {
      return { live: null, roomId: null, liveUrl: null };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { live: null, roomId: null, liveUrl: null };
    }

    const data = json?.data || {};
    const roomIdRaw = data?.roomid ?? data?.room_id ?? data?.roomId ?? null;
    const roomId = Number(roomIdRaw);
    const normalizedRoomId = Number.isFinite(roomId) && roomId > 0 ? roomId : null;
    const live = Number(data?.liveStatus) === 1;
    const liveUrl = normalizedRoomId ? `https://live.bilibili.com/${normalizedRoomId}` : null;

    return { live, roomId: normalizedRoomId, liveUrl };
  } catch {
    return { live: null, roomId: null, liveUrl: null };
  } finally {
    clearTimeout(timeout);
  }
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

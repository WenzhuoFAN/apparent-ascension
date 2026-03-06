import { query } from "./db";

export type LiveStatMember = "fiona" | "gladys";

export type LiveSessionStat = {
  id: string;
  member: LiveStatMember;
  mid: string;
  roomId: number;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationSec: number;
  danmakuCount: number;
  peakRealtimeViewers: number;
  revenueCny: number;
  superChatRevenueCny: number;
  giftRevenueCny: number;
  updatedAt: string;
  status: "live" | "ended";
};

const DB_CONTENT_KEY = "stats.live.sessions.v1";

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const clamp = (value: unknown, maxLen: number) => String(value ?? "").trim().slice(0, maxLen);

const clampInt = (value: unknown, max: number) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return Math.min(max, n);
};

const clampMoney = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
};

const isIsoDatetime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);

const normalizeMember = (value: unknown): LiveStatMember | null => {
  if (value === "fiona" || value === "gladys") return value;
  return null;
};

const normalizeOne = (raw: unknown, fallbackId: string): LiveSessionStat | null => {
  if (!isObject(raw)) return null;

  const id = clamp(raw.id, 120) || fallbackId;
  const member = normalizeMember(raw.member);
  const mid = clamp(raw.mid, 24);
  const roomId = clampInt(raw.roomId, 999999999);
  const title = clamp(raw.title, 140);
  const startedAt = clamp(raw.startedAt, 64);
  const endedAt = clamp(raw.endedAt, 64);
  const updatedAt = clamp(raw.updatedAt, 64);
  const status = raw.status === "live" ? "live" : raw.status === "ended" ? "ended" : null;

  if (!member || !mid || !roomId || !title || !isIsoDatetime(startedAt) || !isIsoDatetime(updatedAt) || !status) {
    return null;
  }

  return {
    id,
    member,
    mid,
    roomId,
    title,
    startedAt,
    endedAt: isIsoDatetime(endedAt) ? endedAt : undefined,
    durationSec: clampInt(raw.durationSec, 60 * 60 * 24 * 30),
    danmakuCount: clampInt(raw.danmakuCount, 10_000_000),
    peakRealtimeViewers: clampInt(raw.peakRealtimeViewers, 100_000_000),
    revenueCny: clampMoney(raw.revenueCny),
    superChatRevenueCny: clampMoney(raw.superChatRevenueCny),
    giftRevenueCny: clampMoney(raw.giftRevenueCny),
    updatedAt,
    status,
  };
};

const normalizeMany = (raw: unknown): LiveSessionStat[] => {
  if (!Array.isArray(raw)) return [];

  const rows: LiveSessionStat[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const row = normalizeOne(raw[i], `live-${i + 1}`);
    if (!row) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }

  rows.sort((a, b) => {
    const byStart = b.startedAt.localeCompare(a.startedAt);
    if (byStart !== 0) return byStart;
    return a.member.localeCompare(b.member);
  });

  return rows.slice(0, 2000);
};

export const getLiveSessionStats = async (): Promise<LiveSessionStat[]> => {
  const result = await query<{ content_json: unknown }>(
    `SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1`,
    [DB_CONTENT_KEY],
  );

  if (!result.rowCount) return [];
  return normalizeMany(result.rows[0].content_json);
};


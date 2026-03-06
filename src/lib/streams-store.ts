import { getCollection } from "astro:content";
import { query } from "./db";
import { getLiveSessionStats } from "./live-stats-store";

export type StreamMember = "fiona" | "gladys" | "both";

export type StreamRecord = {
  id: string;
  slug: string;
  date: string;
  member: StreamMember;
  title: string;
  durationMin?: number;
  replayUrl?: string;
  highlights: string[];
  tags: string[];
  relatedClips: string[];
  relatedFanworks: string[];
  source: "content" | "live-db";
  startedAt?: string;
  endedAt?: string;
  danmakuCount?: number;
  peakRealtimeViewers?: number;
  revenueCny?: number;
  superChatRevenueCny?: number;
  giftRevenueCny?: number;
};

const DB_CONTENT_KEY = "streams.records.v1";

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

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const normalizeMember = (value: unknown): StreamMember | null => {
  if (value === "fiona" || value === "gladys" || value === "both") return value;
  return null;
};

const normalizeTags = (value: unknown, maxLen = 30, itemMaxLen = 32) => {
  if (!Array.isArray(value)) return [] as string[];
  return value
    .map((x) => clamp(x, itemMaxLen))
    .filter(Boolean)
    .slice(0, maxLen);
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const normalizeOne = (raw: unknown, fallbackId: string): StreamRecord | null => {
  if (!isObject(raw)) return null;

  const id = clamp(raw.id, 120) || fallbackId;
  const slug = slugify(clamp(raw.slug, 140) || id) || fallbackId;
  const date = clamp(raw.date, 10);
  const member = normalizeMember(raw.member);
  const title = clamp(raw.title, 140);
  if (!isIsoDate(date) || !member || !title) return null;

  const durationMinRaw = clampInt(raw.durationMin, 60 * 24);
  const replayUrl = clamp(raw.replayUrl, 500);

  return {
    id,
    slug,
    date,
    member,
    title,
    durationMin: durationMinRaw > 0 ? durationMinRaw : undefined,
    replayUrl: replayUrl || undefined,
    highlights: normalizeTags(raw.highlights, 20, 200),
    tags: normalizeTags(raw.tags, 20, 40),
    relatedClips: normalizeTags(raw.relatedClips, 40, 120),
    relatedFanworks: normalizeTags(raw.relatedFanworks, 40, 120),
    source: raw.source === "live-db" ? "live-db" : "content",
    startedAt: clamp(raw.startedAt, 64) || undefined,
    endedAt: clamp(raw.endedAt, 64) || undefined,
    danmakuCount: clampInt(raw.danmakuCount, 10_000_000) || undefined,
    peakRealtimeViewers: clampInt(raw.peakRealtimeViewers, 100_000_000) || undefined,
    revenueCny: clampMoney(raw.revenueCny) || undefined,
    superChatRevenueCny: clampMoney(raw.superChatRevenueCny) || undefined,
    giftRevenueCny: clampMoney(raw.giftRevenueCny) || undefined,
  };
};

const normalizeMany = (raw: unknown): StreamRecord[] => {
  if (!Array.isArray(raw)) return [];
  const out: StreamRecord[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const row = normalizeOne(raw[i], `stream-${i + 1}`);
    if (!row) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }

  out.sort((a, b) => b.date.localeCompare(a.date));
  return out.slice(0, 5000);
};

const toDbPayload = (rows: StreamRecord[]) =>
  rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    date: row.date,
    member: row.member,
    title: row.title,
    durationMin: row.durationMin,
    replayUrl: row.replayUrl,
    highlights: row.highlights,
    tags: row.tags,
    relatedClips: row.relatedClips,
    relatedFanworks: row.relatedFanworks,
    source: row.source,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    danmakuCount: row.danmakuCount,
    peakRealtimeViewers: row.peakRealtimeViewers,
    revenueCny: row.revenueCny,
    superChatRevenueCny: row.superChatRevenueCny,
    giftRevenueCny: row.giftRevenueCny,
  }));

type ReadDbResult = {
  exists: boolean;
  rows: StreamRecord[];
};

const readStreamsFromDb = async (): Promise<ReadDbResult> => {
  const result = await query<{ content_json: unknown }>(
    `SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1`,
    [DB_CONTENT_KEY],
  );
  if (!result.rowCount) return { exists: false, rows: [] };
  return { exists: true, rows: normalizeMany(result.rows[0].content_json) };
};

const saveStreamsToDb = async (rows: StreamRecord[]) => {
  await query(
    `
      INSERT INTO site_content (content_key, content_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (content_key)
      DO UPDATE SET content_json = EXCLUDED.content_json, updated_at = NOW()
    `,
    [DB_CONTENT_KEY, JSON.stringify(toDbPayload(rows))],
  );
};

const readStreamsFromContent = async (): Promise<StreamRecord[]> => {
  try {
    const entries = await getCollection("streams");
    const rows = entries
      .map((entry, idx) =>
        normalizeOne(
          {
            id: entry.id,
            slug: entry.slug,
            date: entry.data.date,
            member: entry.data.member,
            title: entry.data.title,
            durationMin: entry.data.durationMin,
            replayUrl: entry.data.replayUrl,
            highlights: entry.data.highlights,
            tags: entry.data.tags,
            relatedClips: entry.data.relatedClips,
            relatedFanworks: entry.data.relatedFanworks,
            source: "content",
          },
          `content-${idx + 1}`,
        ),
      )
      .filter((row): row is StreamRecord => !!row);

    rows.sort((a, b) => b.date.localeCompare(a.date));
    return rows;
  } catch {
    return [];
  }
};

const deriveStreamsFromLiveSessions = async (): Promise<StreamRecord[]> => {
  const sessions = await getLiveSessionStats();
  const rows: StreamRecord[] = [];

  for (const session of sessions) {
    const start = new Date(session.startedAt);
    if (Number.isNaN(start.getTime())) continue;
    const date = start.toISOString().slice(0, 10);
    const durationMin = session.durationSec > 0 ? Math.max(1, Math.round(session.durationSec / 60)) : undefined;
    const member: StreamMember = session.member;
    const id = `live-${session.id}`;
    const baseTags = ["auto", "live-metrics"];
    const tags = member === "fiona" ? ["fiona", ...baseTags] : ["gladys", ...baseTags];

    rows.push({
      id,
      slug: slugify(id) || id,
      date,
      member,
      title: session.title,
      durationMin,
      replayUrl: undefined,
      highlights: [],
      tags,
      relatedClips: [],
      relatedFanworks: [],
      source: "live-db",
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      danmakuCount: session.danmakuCount,
      peakRealtimeViewers: session.peakRealtimeViewers,
      revenueCny: session.revenueCny,
      superChatRevenueCny: session.superChatRevenueCny,
      giftRevenueCny: session.giftRevenueCny,
    });
  }

  rows.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    return (b.startedAt || "").localeCompare(a.startedAt || "");
  });

  return rows;
};

const mergeRows = (primary: StreamRecord[], secondary: StreamRecord[]) => {
  const out = new Map<string, StreamRecord>();

  const insert = (row: StreamRecord) => {
    const key = row.source === "live-db" ? row.id : `slug:${row.slug}`;
    if (!out.has(key)) out.set(key, row);
  };

  primary.forEach(insert);
  secondary.forEach(insert);

  const rows = [...out.values()];
  rows.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    if (byDate !== 0) return byDate;
    return (b.startedAt || "").localeCompare(a.startedAt || "");
  });
  return rows.slice(0, 5000);
};

export const getStreamRecords = async (): Promise<StreamRecord[]> => {
  let dbRows: StreamRecord[] = [];
  let dbExists = false;

  try {
    const db = await readStreamsFromDb();
    dbExists = db.exists;
    dbRows = db.rows;
  } catch {
    dbExists = false;
    dbRows = [];
  }

  const [contentRows, liveRows] = await Promise.all([readStreamsFromContent(), deriveStreamsFromLiveSessions()]);
  const computed = mergeRows(liveRows, contentRows);

  if (!dbExists || JSON.stringify(toDbPayload(dbRows)) !== JSON.stringify(toDbPayload(computed))) {
    try {
      await saveStreamsToDb(computed);
    } catch {
      // Ignore transient DB write errors; caller can still use computed rows.
    }
  }

  if (computed.length) return computed;
  return dbRows;
};

export const getStreamRecordBySlug = async (slug: string) => {
  const rows = await getStreamRecords();
  return rows.find((row) => row.slug === slug) ?? null;
};

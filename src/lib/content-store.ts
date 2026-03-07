import { query } from "./db";

export const CONTENT_KEYS = {
  schedule: "schedule.manual.entries.v3",
  homeLatest: "home.latest.recs.v1",
  startCustom: "start.custom.recs.v1",
  libraryCustom: "library.custom.recs.v1",
  startHiddenStatic: "start.hidden.static.recs.v1",
  notices: "notice.announcements.v1",
} as const;

export const PUBLIC_CONTENT_KEYS = new Set<string>(Object.values(CONTENT_KEYS));
export const ADMIN_MUTABLE_CONTENT_KEYS = new Set<string>(Object.values(CONTENT_KEYS));

type ScheduleRoom = "fiona" | "gladys" | "both";
type ScheduleSourceType = "manual" | "auto";

type ScheduleEntry = {
  id: string;
  title: string;
  date: string;
  time: string;
  room: ScheduleRoom;
  category?: string;
  mode?: string;
  tags: string[];
  sourceType: ScheduleSourceType;
  sourceMid?: string;
  sourceDynamicId?: string;
  sourceUrl?: string;
  imageUrl?: string;
  confidence?: number;
  updatedAt?: string;
  importedAt?: string;
};

type StartCustomRec = {
  id: string;
  section: "must" | "kilo";
  url: string;
  title: string;
  cover?: string;
  reason?: string;
  createdAt?: string;
};

type ManualRecommendation = {
  id: string;
  url: string;
  title: string;
  cover?: string;
  reason?: string;
  createdAt?: string;
};

type NoticeEntry = {
  id: string;
  title?: string;
  text: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

const clampString = (value: unknown, maxLen: number) => String(value || "").trim().slice(0, maxLen);

const normalizeStringArray = (value: unknown, limit: number, itemMaxLen: number) => {
  if (!Array.isArray(value)) return [] as string[];
  return value.map((item) => clampString(item, itemMaxLen)).filter(Boolean).slice(0, limit);
};

const normalizeScheduleRoom = (value: unknown): ScheduleRoom | null => {
  if (value === "fiona" || value === "gladys" || value === "both") return value;
  return null;
};

const normalizeScheduleSourceType = (value: unknown): ScheduleSourceType =>
  value === "auto" ? "auto" : "manual";

const clampScheduleConfidence = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.max(0, Math.min(1, Math.round(num * 100) / 100));
};

const createScheduleId = (title: string, date: string, time: string, room: ScheduleRoom) => {
  try {
    const raw = `${date}|${time}|${room}|${title}`;
    return `schedule-${Buffer.from(raw, "utf8").toString("base64url").slice(0, 48)}`;
  } catch {
    return `schedule-${date}-${time}-${room}`;
  }
};

const normalizeSchedule = (value: unknown): ScheduleEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: ScheduleEntry[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!isObject(row)) continue;
    const title = clampString(row.title, 200);
    const date = clampString(row.date, 10);
    const time = clampString(row.time, 5);
    const room = normalizeScheduleRoom(row.room);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !room) continue;

    const id = clampString(row.id, 120) || createScheduleId(title, date, time, room);
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      title,
      date,
      time,
      room,
      category: clampString(row.category ?? row.type, 40) || undefined,
      mode: clampString(row.mode, 32) || undefined,
      tags: normalizeStringArray(row.tags, 10, 24),
      sourceType: normalizeScheduleSourceType(row.sourceType),
      sourceMid: clampString(row.sourceMid, 24) || undefined,
      sourceDynamicId: clampString(row.sourceDynamicId, 80) || undefined,
      sourceUrl: clampString(row.sourceUrl, 500) || undefined,
      imageUrl: clampString(row.imageUrl, 500) || undefined,
      confidence: clampScheduleConfidence(row.confidence),
      updatedAt: clampString(row.updatedAt, 64) || undefined,
      importedAt: clampString(row.importedAt, 64) || undefined,
    });
  }

  out.sort((a, b) => {
    const byDateTime = `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`);
    if (byDateTime !== 0) return byDateTime;
    const byRoom = a.room.localeCompare(b.room);
    if (byRoom !== 0) return byRoom;
    return a.title.localeCompare(b.title);
  });

  return out.slice(0, 800);
};

const normalizeStartCustom = (value: unknown): StartCustomRec[] => {
  if (!Array.isArray(value)) return [];
  const out: StartCustomRec[] = [];
  for (const row of value) {
    if (!isObject(row)) continue;
    const id = clampString(row.id, 80);
    const section = row.section === "kilo" ? "kilo" : row.section === "must" ? "must" : null;
    const url = clampString(row.url, 500);
    const title = clampString(row.title, 140);
    const cover = clampString(row.cover, 500);
    const reason = clampString(row.reason, 240);
    if (!id || !section || !url || !title) continue;
    out.push({
      id,
      section,
      url,
      title,
      cover: cover || undefined,
      reason: reason || undefined,
      createdAt: clampString(row.createdAt, 64) || undefined,
    });
  }
  return out.slice(0, 120);
};

const normalizeManualRecommendations = (value: unknown): ManualRecommendation[] => {
  if (!Array.isArray(value)) return [];
  const out: ManualRecommendation[] = [];
  for (const row of value) {
    if (!isObject(row)) continue;
    const id = clampString(row.id, 80);
    const url = clampString(row.url, 500);
    const title = clampString(row.title, 140);
    const cover = clampString(row.cover, 500);
    const reason = clampString(row.reason, 240);
    if (!id || !url || !title) continue;
    out.push({
      id,
      url,
      title,
      cover: cover || undefined,
      reason: reason || undefined,
      createdAt: clampString(row.createdAt, 64) || undefined,
    });
  }
  return out.slice(0, 180);
};

const normalizeHiddenStatic = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((x) => clampString(x, 120)).filter(Boolean).slice(0, 200);
};

const normalizeNotices = (value: unknown): NoticeEntry[] => {
  if (!Array.isArray(value)) return [];

  const out: NoticeEntry[] = [];
  const seen = new Set<string>();

  for (const row of value) {
    if (!isObject(row)) continue;

    const id = clampString(row.id, 80);
    if (!id || seen.has(id)) continue;

    const text = clampString(row.text, 10_000);
    const createdAt = clampString(row.createdAt, 64);
    const updatedAt = clampString(row.updatedAt, 64);
    if (!text || !createdAt || !updatedAt) continue;

    seen.add(id);
    out.push({
      id,
      title: clampString(row.title, 120) || undefined,
      text,
      published: !!row.published,
      createdAt,
      updatedAt,
      publishedAt: clampString(row.publishedAt, 64) || undefined,
    });
  }

  out.sort((a, b) => {
    const aKey = a.publishedAt || a.updatedAt;
    const bKey = b.publishedAt || b.updatedAt;
    return bKey.localeCompare(aKey);
  });

  return out.slice(0, 500);
};

export const normalizeContentByKey = (key: string, value: unknown): unknown => {
  if (key === CONTENT_KEYS.schedule) return normalizeSchedule(value);
  if (key === CONTENT_KEYS.homeLatest) return normalizeManualRecommendations(value);
  if (key === CONTENT_KEYS.startCustom) return normalizeStartCustom(value);
  if (key === CONTENT_KEYS.libraryCustom) return normalizeManualRecommendations(value);
  if (key === CONTENT_KEYS.startHiddenStatic) return normalizeHiddenStatic(value);
  if (key === CONTENT_KEYS.notices) return normalizeNotices(value);
  throw new Error(`Unsupported content key: ${key}`);
};

const defaultValueByKey = (key: string): unknown => {
  if (key === CONTENT_KEYS.schedule) return [];
  if (key === CONTENT_KEYS.homeLatest) return [];
  if (key === CONTENT_KEYS.startCustom) return [];
  if (key === CONTENT_KEYS.libraryCustom) return [];
  if (key === CONTENT_KEYS.startHiddenStatic) return [];
  if (key === CONTENT_KEYS.notices) return [];
  return [];
};

export const getContentByKey = async (key: string) => {
  const fallback = defaultValueByKey(key);
  const result = await query<{ content_json: unknown }>(
    `SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1`,
    [key],
  );
  if (!result.rowCount) {
    return normalizeContentByKey(key, fallback);
  }
  return normalizeContentByKey(key, result.rows[0].content_json);
};

export const setContentByKey = async (key: string, value: unknown) => {
  const normalized = normalizeContentByKey(key, value);
  await query(
    `
      INSERT INTO site_content (content_key, content_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (content_key)
      DO UPDATE SET content_json = EXCLUDED.content_json, updated_at = NOW()
    `,
    [key, JSON.stringify(normalized)],
  );
  return normalized;
};

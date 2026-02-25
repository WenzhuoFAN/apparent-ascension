import { query } from "./db";

export const CONTENT_KEYS = {
  schedule: "schedule.manual.entries.v3",
  startCustom: "start.custom.recs.v1",
  startHiddenStatic: "start.hidden.static.recs.v1",
} as const;

export const PUBLIC_CONTENT_KEYS = new Set<string>(Object.values(CONTENT_KEYS));
export const ADMIN_MUTABLE_CONTENT_KEYS = new Set<string>(Object.values(CONTENT_KEYS));

type ScheduleEntry = {
  title: string;
  date: string;
  time: string;
  room: "fiona" | "gladys";
  updatedAt?: string;
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

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

const clampString = (value: unknown, maxLen: number) => String(value || "").trim().slice(0, maxLen);

const normalizeSchedule = (value: unknown): ScheduleEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: ScheduleEntry[] = [];
  for (const row of value) {
    if (!isObject(row)) continue;
    const title = clampString(row.title, 200);
    const date = clampString(row.date, 10);
    const time = clampString(row.time, 5);
    const room = row.room === "gladys" ? "gladys" : row.room === "fiona" ? "fiona" : null;
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !room) continue;
    out.push({
      title,
      date,
      time,
      room,
      updatedAt: clampString(row.updatedAt, 64) || undefined,
    });
  }
  return out.slice(0, 366);
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

const normalizeHiddenStatic = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((x) => clampString(x, 120)).filter(Boolean).slice(0, 200);
};

export const normalizeContentByKey = (key: string, value: unknown): unknown => {
  if (key === CONTENT_KEYS.schedule) return normalizeSchedule(value);
  if (key === CONTENT_KEYS.startCustom) return normalizeStartCustom(value);
  if (key === CONTENT_KEYS.startHiddenStatic) return normalizeHiddenStatic(value);
  throw new Error(`Unsupported content key: ${key}`);
};

const defaultValueByKey = (key: string): unknown => {
  if (key === CONTENT_KEYS.schedule) return [];
  if (key === CONTENT_KEYS.startCustom) return [];
  if (key === CONTENT_KEYS.startHiddenStatic) return [];
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


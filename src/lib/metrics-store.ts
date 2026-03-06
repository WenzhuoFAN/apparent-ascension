import { getCollection } from "astro:content";
import { query } from "./db";

export type MetricMember = "fiona" | "gladys" | "both";

export type MetricRow = {
  date: string;
  capturedAt?: string;
  member: MetricMember;
  followers: number;
  note?: string;
};

const DB_CONTENT_KEY = "stats.followers.v1";

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const clamp = (value: unknown, maxLen: number) => String(value ?? "").trim().slice(0, maxLen);

const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const normalizeMember = (value: unknown): MetricMember | null => {
  if (value === "fiona" || value === "gladys" || value === "both") return value;
  return null;
};

const normalizeMetricRow = (raw: unknown): MetricRow | null => {
  if (!isObject(raw)) return null;

  const date = clamp(raw.date, 10);
  const member = normalizeMember(raw.member);
  const followers = Number(raw.followers);
  if (!isIsoDate(date) || !member || !Number.isInteger(followers) || followers < 0) return null;

  const capturedAt = clamp(raw.capturedAt, 64);
  const note = clamp(raw.note, 120);

  return {
    date,
    member,
    followers,
    capturedAt: capturedAt || undefined,
    note: note || undefined,
  };
};

const sortRows = (rows: MetricRow[]) => {
  rows.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;

    const byMember = a.member.localeCompare(b.member);
    if (byMember !== 0) return byMember;

    return (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "");
  });
};

const dedupeRows = (rows: MetricRow[]) => {
  const sorted = rows.slice();
  sortRows(sorted);

  const byDateMember = new Map<string, MetricRow>();
  for (const row of sorted) {
    byDateMember.set(`${row.date}|${row.member}`, row);
  }

  const merged = [...byDateMember.values()];
  sortRows(merged);
  return merged;
};

const normalizeMany = (raw: unknown): MetricRow[] => {
  if (!Array.isArray(raw)) return [];
  const out: MetricRow[] = [];
  for (const item of raw) {
    const row = normalizeMetricRow(item);
    if (!row) continue;
    out.push(row);
  }
  return dedupeRows(out).slice(0, 4000);
};

const toDbPayload = (rows: MetricRow[]) =>
  rows.map((row) => ({
    date: row.date,
    capturedAt: row.capturedAt,
    member: row.member,
    followers: row.followers,
    note: row.note,
  }));

type ReadDbResult = {
  exists: boolean;
  rows: MetricRow[];
};

const readMetricsFromDb = async (): Promise<ReadDbResult> => {
  const result = await query<{ content_json: unknown }>(
    `SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1`,
    [DB_CONTENT_KEY],
  );
  if (!result.rowCount) return { exists: false, rows: [] };
  return {
    exists: true,
    rows: normalizeMany(result.rows[0].content_json),
  };
};

const seedMetricsToDb = async (rows: MetricRow[]) => {
  await query(
    `
      INSERT INTO site_content (content_key, content_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (content_key)
      DO NOTHING
    `,
    [DB_CONTENT_KEY, JSON.stringify(toDbPayload(rows))],
  );
};

const readMetricsFromCollection = async (): Promise<MetricRow[]> => {
  try {
    const metrics = await getCollection("metrics");
    const rawRows = metrics.flatMap((entry) => (Array.isArray(entry.data) ? entry.data : []));
    return normalizeMany(rawRows);
  } catch {
    return [];
  }
};

export const getFollowerMetrics = async (): Promise<MetricRow[]> => {
  let shouldSeed = true;

  try {
    const dbResult = await readMetricsFromDb();
    if (dbResult.exists) return dbResult.rows;
  } catch {
    shouldSeed = false;
  }

  const rowsFromCollection = await readMetricsFromCollection();

  if (shouldSeed) {
    try {
      await seedMetricsToDb(rowsFromCollection);
    } catch {
      // Ignore transient DB write failures and serve fallback rows.
    }
  }

  return rowsFromCollection;
};

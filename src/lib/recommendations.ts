import { getCollection } from "astro:content";
import { query } from "./db";

export type RecommendationKind = "clips" | "fanworks";
export type RecommendationMember = "fiona" | "gladys" | "both";

export type Recommendation = {
  id: string;
  slug: string;
  kind: RecommendationKind;
  title: string;
  url: string;
  member: RecommendationMember;
  tags: string[];
  author?: string;
  cover?: string;
  platform?: string;
  reason?: string;
  createdAt?: string;
};

const DB_CONTENT_KEY_BY_KIND: Record<RecommendationKind, string> = {
  clips: "library.clips.v1",
  fanworks: "library.fanworks.v1",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object";

const clamp = (value: unknown, maxLen: number) => String(value ?? "").trim().slice(0, maxLen);

const normalizeMember = (value: unknown): RecommendationMember | null => {
  if (value === "fiona" || value === "gladys" || value === "both") return value;
  return null;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const normalizeTags = (value: unknown) => {
  if (!Array.isArray(value)) return [] as string[];
  return value.map((x) => clamp(x, 40)).filter(Boolean).slice(0, 20);
};

const normalizeOne = (
  raw: unknown,
  kind: RecommendationKind,
  fallbackId: string,
): Recommendation | null => {
  if (!isObject(raw)) return null;

  const title = clamp(raw.title, 140);
  const url = clamp(raw.url, 500);
  const member = normalizeMember(raw.member);
  if (!title || !/^https?:\/\//i.test(url) || !member) return null;

  const id = clamp(raw.id, 120) || clamp(raw.slug, 120) || fallbackId;
  const slug = slugify(clamp(raw.slug, 120) || id || title) || fallbackId;

  return {
    id,
    slug,
    kind,
    title,
    url,
    member,
    tags: normalizeTags(raw.tags),
    author: clamp(raw.author, 80) || undefined,
    cover: clamp(raw.cover, 500) || undefined,
    platform: clamp(raw.platform, 40) || undefined,
    reason: clamp(raw.reason, 240) || undefined,
    createdAt: clamp(raw.createdAt, 64) || undefined,
  };
};

const normalizeMany = (raw: unknown, kind: RecommendationKind): Recommendation[] => {
  if (!Array.isArray(raw)) return [];

  const out: Recommendation[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i += 1) {
    const row = normalizeOne(raw[i], kind, `${kind}-${i + 1}`);
    if (!row) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }

  return out.slice(0, 1000);
};

type ReadDbResult = {
  exists: boolean;
  rows: Recommendation[];
};

const toDbPayload = (rows: Recommendation[]) =>
  rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    url: row.url,
    member: row.member,
    tags: row.tags,
    author: row.author,
    cover: row.cover,
    platform: row.platform,
    reason: row.reason,
    createdAt: row.createdAt,
  }));

const readRecommendationsFromDb = async (kind: RecommendationKind): Promise<ReadDbResult> => {
  const contentKey = DB_CONTENT_KEY_BY_KIND[kind];
  const result = await query<{ content_json: unknown }>(
    `SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1`,
    [contentKey],
  );
  if (!result.rowCount) return { exists: false, rows: [] };
  return {
    exists: true,
    rows: normalizeMany(result.rows[0].content_json, kind),
  };
};

const seedRecommendationsToDb = async (kind: RecommendationKind, rows: Recommendation[]) => {
  const contentKey = DB_CONTENT_KEY_BY_KIND[kind];
  await query(
    `
      INSERT INTO site_content (content_key, content_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (content_key)
      DO NOTHING
    `,
    [contentKey, JSON.stringify(toDbPayload(rows))],
  );
};

const readRecommendationsFromCollection = async (kind: RecommendationKind): Promise<Recommendation[]> => {
  try {
    const entries = await getCollection(kind);
    return entries
      .map((entry, idx) =>
        normalizeOne(
          {
            id: entry.id,
            slug: entry.slug,
            title: entry.data.title,
            url: entry.data.url,
            member: entry.data.member,
            tags: entry.data.tags,
            author: entry.data.author,
            cover: entry.data.cover,
            platform: entry.data.platform,
            reason: entry.data.reason,
            createdAt: entry.data.createdAt,
          },
          kind,
          `${kind}-${idx + 1}`,
        ),
      )
      .filter((row): row is Recommendation => !!row);
  } catch {
    return [];
  }
};

export const getRecommendations = async (kind: RecommendationKind): Promise<Recommendation[]> => {
  let shouldSeed = true;
  try {
    const dbResult = await readRecommendationsFromDb(kind);
    if (dbResult.exists) {
      return dbResult.rows;
    }
  } catch {
    // If DB is temporarily unavailable, fallback to content collections for resilience.
    shouldSeed = false;
  }

  const rowsFromCollection = await readRecommendationsFromCollection(kind);

  // Seed DB on first miss, including empty arrays, so future reads avoid repeated collection lookups.
  if (shouldSeed) {
    try {
      await seedRecommendationsToDb(kind, rowsFromCollection);
    } catch {
      // Ignore transient DB write errors and continue serving from content fallback.
    }
  }

  return rowsFromCollection;
};

export const getAllRecommendations = async () => {
  const [clips, fanworks] = await Promise.all([getRecommendations("clips"), getRecommendations("fanworks")]);
  return { clips, fanworks };
};

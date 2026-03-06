import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const MEMBERS = {
  fiona: { mid: "3537115310721181" },
  gladys: { mid: "3537115310721781" },
};

const DB_CONTENT_KEY = "stats.followers.v1";
const METRICS_DIR = path.join(process.cwd(), "src/content/metrics");
const METRICS_FILE = path.join(METRICS_DIR, "all.json");

function dateCN() {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });
  return fmt.format(new Date()); // YYYY-MM-DD
}

function pickConnectionString() {
  const direct = String(process.env.DATABASE_URL || process.env.DATABASE || "").trim();
  if (direct) return direct;

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HEROKU_POSTGRESQL_") && key.endsWith("_URL") && String(value || "").trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function resolvePersistMode(connectionString) {
  const requested = String(process.env.METRICS_PERSIST || "auto").trim().toLowerCase();
  if (requested === "auto") return connectionString ? "db" : "file";
  if (requested === "db") {
    if (!connectionString) throw new Error("METRICS_PERSIST=db requires DATABASE_URL.");
    return "db";
  }
  if (requested === "both") {
    if (!connectionString) {
      console.warn("METRICS_PERSIST=both but DATABASE_URL is missing; fallback to file only.");
      return "file";
    }
    return "both";
  }
  if (requested === "file") return "file";
  throw new Error(`Unsupported METRICS_PERSIST mode: ${requested}`);
}

async function fetchFollower(mid) {
  const url = `https://api.bilibili.com/x/relation/stat?vmid=${mid}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const json = await res.json();
  if (json?.code !== 0) throw new Error(`API error: ${JSON.stringify(json)}`);
  return json.data.follower;
}

function isMetricRow(value) {
  if (!value || typeof value !== "object") return false;
  const row = value;
  return (
    typeof row.date === "string" &&
    typeof row.member === "string" &&
    Number.isInteger(row.followers) &&
    row.followers >= 0
  );
}

function sortRows(rows) {
  rows.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;

    const byMember = a.member.localeCompare(b.member);
    if (byMember !== 0) return byMember;

    return (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "");
  });
}

function upsertMetric(rows, row) {
  const idx = rows.findIndex((x) => x.date === row.date && x.member === row.member);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
}

function dedupeRows(rows) {
  const sorted = rows.slice();
  sortRows(sorted);
  const out = [];
  for (const row of sorted) {
    upsertMetric(out, row);
  }
  sortRows(out);
  return out;
}

function normalizeRows(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const item of raw) {
    if (!isMetricRow(item)) continue;
    rows.push({
      date: item.date,
      capturedAt: typeof item.capturedAt === "string" ? item.capturedAt : undefined,
      member: item.member,
      followers: item.followers,
      note: typeof item.note === "string" ? item.note : undefined,
    });
  }
  return dedupeRows(rows);
}

async function readRowsAndFiles() {
  await fs.mkdir(METRICS_DIR, { recursive: true });

  let files = [];
  try {
    files = await fs.readdir(METRICS_DIR);
  } catch {
    files = [];
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const rows = [];

  for (const fileName of jsonFiles) {
    const fullPath = path.join(METRICS_DIR, fileName);

    try {
      const parsed = JSON.parse(await fs.readFile(fullPath, "utf-8"));
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      rows.push(...normalizeRows(batch));
    } catch (err) {
      console.warn(`skip invalid metrics file: ${fullPath}`, err.message);
    }
  }

  return { rows: dedupeRows(rows), jsonFiles };
}

function isLocalConnection(url) {
  return /localhost|127\.0\.0\.1/i.test(url);
}

function buildPool(connectionString) {
  return new Pool({
    connectionString,
    ssl: isLocalConnection(connectionString) ? undefined : { rejectUnauthorized: false },
  });
}

async function ensureSiteContentTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_content (
      content_key TEXT PRIMARY KEY,
      content_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function readRowsFromDb(connectionString) {
  const pool = buildPool(connectionString);
  try {
    await ensureSiteContentTable(pool);
    const result = await pool.query("SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1", [
      DB_CONTENT_KEY,
    ]);
    if (!result.rowCount) return [];
    return normalizeRows(result.rows[0].content_json);
  } finally {
    await pool.end();
  }
}

async function saveRowsToDb(connectionString, rows) {
  const pool = buildPool(connectionString);
  try {
    await ensureSiteContentTable(pool);
    await pool.query(
      `
        INSERT INTO site_content (content_key, content_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (content_key)
        DO UPDATE SET content_json = EXCLUDED.content_json, updated_at = NOW()
      `,
      [DB_CONTENT_KEY, JSON.stringify(rows)],
    );
    console.log("updated DB key", DB_CONTENT_KEY, `(${rows.length} rows)`);
  } finally {
    await pool.end();
  }
}

async function saveRowsToFile(rows, jsonFiles) {
  sortRows(rows);
  await fs.writeFile(METRICS_FILE, JSON.stringify(rows, null, 2) + "\n", "utf-8");
  console.log("updated", METRICS_FILE);

  const legacyFiles = jsonFiles.filter((f) => f !== "all.json");
  for (const fileName of legacyFiles) {
    const fullPath = path.join(METRICS_DIR, fileName);
    try {
      await fs.unlink(fullPath);
      console.log("removed legacy metrics file:", fullPath);
    } catch (err) {
      console.warn(`failed to remove legacy metrics file: ${fullPath}`, err.message);
    }
  }
}

async function main() {
  const date = dateCN();
  const connectionString = pickConnectionString();
  const persistMode = resolvePersistMode(connectionString);

  const needsFileAccess = persistMode === "file" || persistMode === "both";
  const { rows: fileRows, jsonFiles } = needsFileAccess
    ? await readRowsAndFiles()
    : { rows: [], jsonFiles: [] };
  const dbRows =
    persistMode === "db" || persistMode === "both"
      ? await readRowsFromDb(connectionString)
      : [];

  const rows = dedupeRows(dbRows.length ? dbRows : fileRows);

  for (const [member, cfg] of Object.entries(MEMBERS)) {
    const followers = await fetchFollower(cfg.mid);
    upsertMetric(rows, {
      date,
      capturedAt: new Date().toISOString(),
      member,
      followers,
      note: "auto",
    });
  }

  const finalRows = dedupeRows(rows);

  if (persistMode === "db" || persistMode === "both") {
    await saveRowsToDb(connectionString, finalRows);
  }

  if (persistMode === "file" || persistMode === "both") {
    await saveRowsToFile(finalRows, jsonFiles);
  }

  console.log(`done (mode=${persistMode})`);
}

await main();

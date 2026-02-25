import fs from "node:fs/promises";
import path from "node:path";

const MEMBERS = {
  fiona:  { mid: "3537115310721181" },
  gladys: { mid: "3537115310721781" },
};

const METRICS_DIR = path.join(process.cwd(), "src/content/metrics");
const METRICS_FILE = path.join(METRICS_DIR, "all.json");

function dateCN() {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });
  return fmt.format(new Date()); // YYYY-MM-DD
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

      for (const item of batch) {
        if (!isMetricRow(item)) continue;
        rows.push({
          date: item.date,
          capturedAt: typeof item.capturedAt === "string" ? item.capturedAt : undefined,
          member: item.member,
          followers: item.followers,
          note: typeof item.note === "string" ? item.note : undefined,
        });
      }
    } catch (err) {
      console.warn(`skip invalid metrics file: ${fullPath}`, err.message);
    }
  }

  return { rows, jsonFiles };
}

function upsertMetric(rows, row) {
  const idx = rows.findIndex((x) => x.date === row.date && x.member === row.member);
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
}

async function saveRows(rows, jsonFiles) {
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
  const { rows, jsonFiles } = await readRowsAndFiles();

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

  await saveRows(rows, jsonFiles);
}

await main();

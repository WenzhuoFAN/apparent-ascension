import fs from "node:fs/promises";
import path from "node:path";

const TIME_RE = /(?:^|[^0-9])([01]?\d|2[0-3])[:：.](\d{2})(?:[^0-9]|$)/;
const DATE_GLOBAL_RE = /(\d{1,2})[.\-/](\d{1,2})/g;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function usageAndExit() {
  console.error(
    [
      "Usage:",
      "  node scripts/extract-schedule-from-image.mjs --ocr-json <path> [--year 2026] [--week-start YYYY-MM-DD] [--out <path>]",
      "",
      "Example:",
      "  node scripts/extract-schedule-from-image.mjs --ocr-json scripts/_tmp/ocr.json --year 2026",
    ].join("\n")
  );
  process.exit(1);
}

function normalizeText(input) {
  return String(input)
    .replace(/[：]/g, ":")
    .replace(/[。．]/g, ".")
    .replace(/[·•]/g, ".")
    .replace(/[【】]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function lineCenterX(line) {
  return line.x + line.width / 2;
}

function clusterByY(items, maxDelta = 18) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const clusters = [];
  for (const item of sorted) {
    const found = clusters.find((c) => Math.abs(c.y - item.y) <= maxDelta);
    if (!found) {
      clusters.push({ y: item.y, items: [item] });
      continue;
    }
    found.items.push(item);
    found.y = found.items.reduce((sum, x) => sum + x.y, 0) / found.items.length;
  }
  return clusters;
}

function pickDateColumns(lines, imageHeight) {
  const candidates = [];
  for (const line of lines) {
    if (line.y > imageHeight * 0.58) continue;
    const normalized = normalizeText(line.text);
    let match;
    DATE_GLOBAL_RE.lastIndex = 0;
    while ((match = DATE_GLOBAL_RE.exec(normalized)) !== null) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (!Number.isInteger(month) || !Number.isInteger(day)) continue;
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;

      candidates.push({
        month,
        day,
        x: lineCenterX(line),
        y: line.y,
        h: line.height,
      });
    }
  }

  if (!candidates.length) return [];
  const clusters = clusterByY(candidates, 20);
  const ranked = clusters
    .map((c) => {
      const uniqueKeyCount = new Set(c.items.map((i) => `${i.month}-${i.day}-${Math.round(i.x / 10)}`)).size;
      return { ...c, uniqueKeyCount };
    })
    .sort((a, b) => b.uniqueKeyCount - a.uniqueKeyCount);

  const chosen = ranked[0];
  if (!chosen || chosen.items.length < 2) return [];

  const sorted = [...chosen.items].sort((a, b) => a.x - b.x);
  const dedup = [];
  for (const item of sorted) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.x - item.x) <= 18) continue;
    dedup.push(item);
  }
  return dedup;
}

function assignYears(dateColumns, baseYear) {
  if (!dateColumns.length) return [];
  let year = baseYear;
  let prevMonth = dateColumns[0].month;
  return dateColumns.map((d, idx) => {
    if (idx > 0 && d.month < prevMonth - 6) {
      year += 1;
    }
    prevMonth = d.month;
    return { ...d, year };
  });
}

function nearestDateColumn(x, dateColumns) {
  if (!dateColumns.length) return null;
  let best = dateColumns[0];
  let bestDelta = Math.abs(best.x - x);
  for (let i = 1; i < dateColumns.length; i += 1) {
    const current = dateColumns[i];
    const delta = Math.abs(current.x - x);
    if (delta < bestDelta) {
      best = current;
      bestDelta = delta;
    }
  }
  return best;
}

function inferMember(text) {
  const hasFiona = /心宜|fiona/i.test(text);
  const hasGladys = /思诺|gladys/i.test(text);
  if (hasFiona && hasGladys) return "both";
  if (hasFiona) return "fiona";
  if (hasGladys) return "gladys";
  if (/夜谈|聊天室/.test(text)) return "both";
  return null;
}

function cleanTitle(raw) {
  const text = normalizeText(raw)
    .replace(/特别|2D|直播/g, "")
    .replace(/[❤♥★☆→←]/g, "")
    .replace(TIME_RE, "")
    .trim();
  return text;
}

function inferType(title) {
  if (/夜谈|杂谈|聊天|聊天室/.test(title)) return "杂谈";
  if (/歌/.test(title)) return "歌回";
  if (/游戏/.test(title)) return "游戏";
  return "";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toIsoStartAt({ year, month, day, hour, minute }) {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+08:00`;
}

function deriveWeekStartFromIso(isoStartAt) {
  const datePart = isoStartAt.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00+08:00`);
  const weekDay = date.getUTCDay(); // 0 Sun .. 6 Sat
  const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function extractItemsFromOcr(lines, dateColumns) {
  if (!dateColumns.length) return [];

  const headerBottom = Math.max(...dateColumns.map((d) => d.y + d.h));
  const scheduleMinY = headerBottom + 24;
  const columnDiffs = [];
  for (let i = 1; i < dateColumns.length; i += 1) {
    columnDiffs.push(dateColumns[i].x - dateColumns[i - 1].x);
  }
  const estimatedColWidth =
    columnDiffs.length > 0
      ? columnDiffs.slice().sort((a, b) => a - b)[Math.floor(columnDiffs.length / 2)]
      : 140;

  const eventCandidates = [];
  for (const line of lines) {
    if (line.y < scheduleMinY) continue;

    const normalized = normalizeText(line.text);
    const timeMatch = normalized.match(TIME_RE);
    if (!timeMatch) continue;

    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;

    const x = lineCenterX(line);
    const dateCol = nearestDateColumn(x, dateColumns);
    if (!dateCol) continue;

    const neighbors = lines
      .filter((l) => {
        if (l.y < scheduleMinY) return false;
        if (Math.abs(lineCenterX(l) - dateCol.x) > estimatedColWidth * 0.52) return false;
        if (l.y > line.y + 20) return false;
        if (l.y < line.y - 96) return false;
        return true;
      })
      .sort((a, b) => a.y - b.y);

    const contextText = normalizeText(neighbors.map((n) => n.text).join(" "));
    const member = inferMember(contextText);
    if (!member) continue;

    const titleLine = [...neighbors]
      .reverse()
      .find((n) => {
        const t = normalizeText(n.text);
        if (!t) return false;
        if (t === normalized) return false;
        if (TIME_RE.test(t)) return false;
        if (/休息日|训练时间|直播日历|calendar/i.test(t)) return false;
        return true;
      });

    const rawTitle = titleLine ? titleLine.text : "";
    const cleaned = cleanTitle(rawTitle);
    const fallbackTitle =
      member === "both" ? "心宜思诺直播" : member === "fiona" ? "心宜直播" : "思诺直播";
    const title = cleaned || fallbackTitle;
    const type = inferType(title);

    eventCandidates.push({
      startAt: toIsoStartAt({
        year: dateCol.year,
        month: dateCol.month,
        day: dateCol.day,
        hour,
        minute,
      }),
      member,
      title,
      type,
      link: "",
    });
  }

  const dedup = new Map();
  for (const item of eventCandidates) {
    const key = `${item.startAt}|${item.member}`;
    const existing = dedup.get(key);
    if (!existing || item.title.length > existing.title.length) {
      dedup.set(key, item);
    }
  }

  return [...dedup.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function quoteYamlString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function toScheduleMarkdown(weekStart, items) {
  const rows = [
    "---",
    `weekStart: ${quoteYamlString(weekStart)}`,
    "items:",
  ];

  for (const item of items) {
    rows.push(`  - startAt: ${quoteYamlString(item.startAt)}`);
    rows.push(`    member: ${item.member}`);
    rows.push(`    title: ${quoteYamlString(item.title)}`);
    if (item.type) rows.push(`    type: ${quoteYamlString(item.type)}`);
    rows.push(`    link: ${quoteYamlString(item.link ?? "")}`);
  }

  rows.push("---", "");
  return rows.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["ocr-json"]) usageAndExit();

  const ocrJsonPath = path.resolve(process.cwd(), args["ocr-json"]);
  const year = Number(args.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid --year: ${args.year}`);
  }

  const rawOcr = (await fs.readFile(ocrJsonPath, "utf8")).replace(/^\uFEFF/, "");
  const ocr = JSON.parse(rawOcr);
  const lines = Array.isArray(ocr?.lines) ? ocr.lines : [];
  if (!lines.length) {
    throw new Error("OCR result has no lines. Try a clearer image.");
  }

  const imageHeight = Number(ocr?.image?.height) || 0;
  const dateColumns = assignYears(pickDateColumns(lines, imageHeight), year);
  if (!dateColumns.length) {
    throw new Error("Cannot detect date headers from image.");
  }

  const items = extractItemsFromOcr(lines, dateColumns);
  if (!items.length) {
    throw new Error("No Fiona/Gladys schedule items detected. Try a larger/clearer source image.");
  }

  const weekStart = args["week-start"] || deriveWeekStartFromIso(items[0].startAt);
  const markdown = toScheduleMarkdown(weekStart, items);
  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(process.cwd(), "src", "content", "schedule", `${weekStart}.md`);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, markdown, "utf8");

  const debugPath = path.join(
    process.cwd(),
    "scripts",
    "_tmp",
    `ocr-debug-${path.basename(ocr?.image?.path || "image").replace(/\.[^.]+$/, "")}.json`
  );
  await fs.mkdir(path.dirname(debugPath), { recursive: true });
  await fs.writeFile(
    debugPath,
    JSON.stringify(
      {
        imagePath: ocr?.image?.path,
        ocrEngineLanguage: ocr?.engineLanguage,
        dateColumns,
        items,
        lineCount: lines.length,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Generated schedule file: ${outPath}`);
  console.log(`Detected items: ${items.length}`);
  console.log(`OCR debug file: ${debugPath}`);
  console.log("Note: OCR parsing is heuristic. Please manually proofread the generated file.");
}

await main();

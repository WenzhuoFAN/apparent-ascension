import fs from "node:fs/promises";
import path from "node:path";

const TIME_RE = /(?:^|[^0-9])([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?:[^0-9]|$)/;

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
      "  node scripts/extract-schedule-from-image.mjs --ocr-json <path> [--year 2026] [--week-start YYYY-MM-DD] [--out <path>] [--json]",
      "",
      "Example:",
      "  node scripts/extract-schedule-from-image.mjs --ocr-json scripts/_tmp/ocr.json --year 2026",
    ].join("\n"),
  );
  process.exit(1);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function decodeJsonBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return buffer.slice(2).swap16().toString("utf16le").replace(/^\uFEFF/, "");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function normalizeText(input) {
  return String(input || "")
    .replace(/\u3000/g, " ")
    .replace(/[：﹕]/g, ":")
    .replace(/[。．]/g, ".")
    .replace(/[，、]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, "")
    .trim();
}

function parseTimeParts(input) {
  const normalized = normalizeText(input);
  const match = normalized.match(TIME_RE);
  if (match) {
    return {
      hour: Number(match[1]),
      minute: Number(match[2]),
    };
  }

  const specialMatch = normalized.match(/^([四巧])[:：](\d{2})$/);
  if (specialMatch) {
    const hourMap = {
      四: 19,
      巧: 15,
    };
    return {
      hour: hourMap[specialMatch[1]],
      minute: Number(specialMatch[2]),
    };
  }

  return null;
}

function lineCenterX(line) {
  return Number(line.x || 0) + Number(line.width || 0) / 2;
}

function clusterByY(items, maxDelta = 18) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const clusters = [];
  for (const item of sorted) {
    const found = clusters.find((cluster) => Math.abs(cluster.y - item.y) <= maxDelta);
    if (!found) {
      clusters.push({ y: item.y, items: [item] });
      continue;
    }
    found.items.push(item);
    found.y = found.items.reduce((sum, current) => sum + current.y, 0) / found.items.length;
  }
  return clusters;
}

function toDateCandidate(month, day, leftWord, rightWord, y, height) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const left = Number(leftWord?.x || 0);
  const right = Number(rightWord?.x || 0) + Number(rightWord?.width || 0);
  return {
    month,
    day,
    x: (left + right) / 2,
    y,
    h: height,
  };
}

function extractDateCandidatesFromWords(line) {
  const words = Array.isArray(line.words) ? line.words : [];
  const out = [];

  for (let i = 0; i < words.length - 2; i += 1) {
    const first = normalizeText(words[i]?.text);
    const second = normalizeText(words[i + 1]?.text);
    const third = normalizeText(words[i + 2]?.text);
    if (!/^\d{1,2}$/.test(first) || !/^\d{1,2}$/.test(third)) continue;
    if (!second || /^\d+$/.test(second)) continue;

    const candidate = toDateCandidate(
      Number(first),
      Number(third),
      words[i],
      words[i + 2],
      Number(line.y || 0),
      Number(line.height || 0),
    );
    if (candidate) out.push(candidate);
  }

  return out;
}

function extractDateCandidatesFromLine(line) {
  const normalized = normalizeText(line.text);
  const out = [];
  const re = /(\d{1,2})[.\-/](\d{1,2})/g;
  let match;

  while ((match = re.exec(normalized)) !== null) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const ratioStart = match.index / Math.max(1, normalized.length);
    const ratioEnd = (match.index + match[0].length) / Math.max(1, normalized.length);
    const left = Number(line.x || 0) + Number(line.width || 0) * ratioStart;
    const right = Number(line.x || 0) + Number(line.width || 0) * ratioEnd;
    const candidate = {
      month,
      day,
      x: (left + right) / 2,
      y: Number(line.y || 0),
      h: Number(line.height || 0),
    };
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.push(candidate);
  }

  return out;
}

function pickDateColumns(lines, imageHeight) {
  const candidates = [];

  for (const line of lines) {
    if (Number(line.y || 0) > imageHeight * 0.6) continue;
    const fromWords = extractDateCandidatesFromWords(line);
    if (fromWords.length) {
      candidates.push(...fromWords);
      continue;
    }
    candidates.push(...extractDateCandidatesFromLine(line));
  }

  if (!candidates.length) return [];
  const clusters = clusterByY(candidates, 24)
    .map((cluster) => ({
      ...cluster,
      uniqueKeyCount: new Set(cluster.items.map((item) => `${item.month}-${item.day}-${Math.round(item.x / 12)}`)).size,
    }))
    .sort((a, b) => b.uniqueKeyCount - a.uniqueKeyCount);

  const chosen = clusters[0];
  if (!chosen || chosen.items.length < 2) return [];

  const dedup = [];
  for (const item of [...chosen.items].sort((a, b) => a.x - b.x)) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.x - item.x) <= 30) continue;
    dedup.push(item);
  }

  return dedup;
}

function assignYears(dateColumns, baseYear) {
  if (!dateColumns.length) return [];
  let year = baseYear;
  let prevMonth = dateColumns[0].month;

  return dateColumns.map((column, index) => {
    if (index > 0 && column.month < prevMonth - 6) year += 1;
    prevMonth = column.month;
    return { ...column, year };
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

function normalizeMemberHints(text) {
  return normalizeText(text)
    .replace(/芯/g, "心")
    .replace(/思偌/g, "思诺")
    .replace(/思詻/g, "思诺")
    .replace(/思諾/g, "思诺")
    .replace(/思诺snow/g, "思诺");
}

function inferMember(text) {
  const normalized = normalizeMemberHints(text);
  const hasFiona = /(心宜|宜思|宜宝|有点宜思|有点直思|心宜直播)/.test(normalized);
  const hasGladys = /(思诺|思诺snow|思诺直播)/.test(normalized);
  const hasOtherMember = /(嘉然|贝拉|向晚|乃琳|珈乐|A-SOUL小剧场)/.test(normalized);

  if (hasFiona && hasGladys) return "both";
  if (hasFiona) return "fiona";
  if (hasGladys) return "gladys";
  if (hasOtherMember) return null;
  if (/春之圆舞曲/.test(normalized)) return "fiona";
  if (/(双人|合播|一起|联动)/.test(normalized)) return "both";
  return null;
}

function cleanupTitle(raw) {
  let text = normalizeMemberHints(raw)
    .replace(/[+＋]/g, "")
    .replace(/[【\[]?2D[】\]]?/gi, "")
    .replace(/直播预约[:：]?/g, "")
    .replace(/有点直思也界/g, "有点宜思的世界")
    .replace(/有点宜思也界/g, "有点宜思的世界")
    .replace(/萏之圆冕曲/g, "春之圆舞曲")
    .replace(/A-?SOULI?J?I?NE?/gi, "A-SOUL小剧场")
    .replace(/B.?RAshow/gi, "B*RA show")
    .replace(/思诺直(?:播)?/g, "思诺直播")
    .replace(/思诺直播播/g, "思诺直播")
    .replace(/[芯心]直直[拖插播搞]?/g, "心宜直播")
    .replace(/[芯心]直播/g, "心宜直播")
    .replace(/心宜直(?:播)?/g, "心宜直播")
    .replace(/贝拉直(?:播)?/g, "贝拉直播")
    .replace(/嘉然&?贝拉直(?:播)?/g, "嘉然&贝拉直播")
    .replace(TIME_RE, "")
    .replace(/^(?:直播|特别|周表|日历)+/g, "")
    .replace(/[()（）]+/g, "")
    .trim();

  text = text.replace(/^[:：.\-]+|[:：.\-]+$/g, "").trim();
  if (!text || /^(休息日|训练时间|直播时间|calendar)$/i.test(text)) return "";
  if (text === "思诺") return "思诺直播";
  if (text === "心宜") return "心宜直播";
  return text;
}

function inferType(title) {
  const normalized = normalizeText(title);
  if (/(杂谈|夜谈|聊天|茶话会)/.test(normalized)) return "杂谈";
  if (/(歌回|唱歌|k歌|ktv)/i.test(normalized)) return "歌回";
  if (/(游戏|生化危机|梦魇)/.test(normalized)) return "游戏";
  if (/(小剧场|联动|一起)/.test(normalized)) return "联动";
  return "";
}

function inferMode(text) {
  const normalized = normalizeText(text);
  if (/2d/i.test(normalized)) return "2D";
  return "";
}

function toIsoStartAt({ year, month, day, hour, minute }) {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+08:00`;
}

function deriveWeekStartFromIso(isoStartAt) {
  const datePart = isoStartAt.slice(0, 10);
  const date = new Date(`${datePart}T00:00:00+08:00`);
  const weekDay = date.getUTCDay();
  const diffToMonday = weekDay === 0 ? -6 : 1 - weekDay;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function isNoiseLine(text) {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (/^(星期[一二三四五六日天]|休息日|训练时间|直播时间|calendar)$/i.test(normalized)) return true;
  if (/^\d{1,2}[.\-/]\d{1,2}$/.test(normalized)) return true;
  return false;
}

function pickTitleCandidates(timeLine, neighbors) {
  const above = neighbors
    .filter((line) => line.y <= timeLine.y + 8)
    .sort((a, b) => b.y - a.y);
  const below = neighbors
    .filter((line) => line.y > timeLine.y + 8)
    .sort((a, b) => a.y - b.y);

  return [...above, ...below].filter((line) => {
    const normalized = normalizeText(line.text);
    if (!normalized) return false;
    if (parseTimeParts(normalized)) return false;
    if (isNoiseLine(normalized)) return false;
    return true;
  });
}

function collectTimeAnchors(lines, dateColumns, scheduleMinY, estimatedColWidth) {
  const anchors = [];

  for (const line of lines) {
    if (Number(line.y || 0) < scheduleMinY) continue;
    if (Number(line.height || 0) > 180) continue;

    const timeParts = parseTimeParts(line.text);
    if (!timeParts) continue;

    const column = nearestDateColumn(lineCenterX(line), dateColumns);
    if (!column) continue;
    if (Math.abs(lineCenterX(line) - column.x) > estimatedColWidth * 0.48) continue;

    anchors.push({
      line,
      timeParts,
      column,
      x: lineCenterX(line),
      y: Number(line.y || 0),
      height: Number(line.height || 0),
    });
  }

  return anchors;
}

function extractItemsFromOcr(lines, dateColumns) {
  if (!dateColumns.length) return [];

  const headerBottom = Math.max(...dateColumns.map((item) => item.y + item.h));
  const scheduleMinY = headerBottom + 28;
  const diffs = [];
  for (let i = 1; i < dateColumns.length; i += 1) diffs.push(dateColumns[i].x - dateColumns[i - 1].x);
  const estimatedColWidth = diffs.length
    ? diffs.slice().sort((a, b) => a - b)[Math.floor(diffs.length / 2)]
    : 360;

  const candidates = [];
  const anchors = collectTimeAnchors(lines, dateColumns, scheduleMinY, estimatedColWidth);

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const { line, timeParts, column: dateCol } = anchor;
    const hour = timeParts.hour;
    const minute = timeParts.minute;

    const sameColumnAnchors = anchors
      .filter((candidate) => candidate.column.year === dateCol.year && candidate.column.month === dateCol.month && candidate.column.day === dateCol.day)
      .sort((a, b) => a.y - b.y);

    const anchorIndex = sameColumnAnchors.findIndex((candidate) => candidate === anchor);
    const prevAnchor = anchorIndex > 0 ? sameColumnAnchors[anchorIndex - 1] : null;
    const nextAnchor = anchorIndex >= 0 && anchorIndex < sameColumnAnchors.length - 1 ? sameColumnAnchors[anchorIndex + 1] : null;

    const upperBound = prevAnchor
      ? Math.round((prevAnchor.y + line.y) / 2)
      : Math.max(scheduleMinY, Number(line.y || 0) - 180);
    const lowerBound = nextAnchor
      ? Math.round((nextAnchor.y + line.y) / 2)
      : Number(line.y || 0) + 72;

    const neighbors = lines
      .filter((candidate) => {
        if (Number(candidate.y || 0) < scheduleMinY) return false;
        if (Math.abs(lineCenterX(candidate) - dateCol.x) > estimatedColWidth * 0.48) return false;
        if (Number(candidate.y || 0) < upperBound) return false;
        if (Number(candidate.y || 0) > lowerBound) return false;
        return true;
      })
      .sort((a, b) => a.y - b.y);

    const contextText = neighbors.map((item) => item.text).join(" ");
    const titleCandidates = pickTitleCandidates(line, neighbors);
    let title = "";
    let member = null;

    for (const titleLine of titleCandidates) {
      const candidateTitle = cleanupTitle(titleLine.text);
      const candidateMember = inferMember(`${candidateTitle} ${contextText}`);
      if (!candidateTitle && !candidateMember) continue;
      title = candidateTitle;
      member = candidateMember;
      if (candidateMember) break;
    }

    if (!member) member = inferMember(contextText);

    if (!member) continue;

    const fallbackTitle =
      member === "both" ? "心宜 / 思诺直播" : member === "fiona" ? "心宜直播" : "思诺直播";

    const mode = inferMode(`${line.text} ${contextText} ${title || fallbackTitle}`);

    candidates.push({
      startAt: toIsoStartAt({
        year: dateCol.year,
        month: dateCol.month,
        day: dateCol.day,
        hour,
        minute,
      }),
      member,
      title: title || fallbackTitle,
      type: inferType(title || fallbackTitle),
      mode,
      link: "",
    });
  }

  const dedup = new Map();
  for (const item of candidates) {
    const key = `${item.startAt}|${item.member}`;
    const existing = dedup.get(key);
    if (!existing || item.title.length > existing.title.length) dedup.set(key, item);
  }

  return [...dedup.values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function extractColumnTimes(lines, dateColumns) {
  if (!dateColumns.length) return {};

  const headerBottom = Math.max(...dateColumns.map((item) => item.y + item.h));
  const scheduleMinY = headerBottom + 28;
  const out = new Map();

  for (const line of lines) {
    if (Number(line.y || 0) < scheduleMinY) continue;
    const timeParts = parseTimeParts(line.text);
    if (!timeParts) continue;

    const hour = pad2(Number(timeParts.hour));
    const minute = pad2(Number(timeParts.minute));
    const column = nearestDateColumn(lineCenterX(line), dateColumns);
    if (!column) continue;

    const key = `${column.year}-${pad2(column.month)}-${pad2(column.day)}`;
    const bucket = out.get(key) || [];
    bucket.push({ time: `${hour}:${minute}`, y: Number(line.y || 0) });
    out.set(key, bucket);
  }

  return Object.fromEntries(
    [...out.entries()].map(([date, rows]) => [
      date,
      rows
        .sort((a, b) => a.y - b.y)
        .map((row) => row.time)
        .filter((time, index, list) => index === list.indexOf(time)),
    ]),
  );
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
    if (item.mode) rows.push(`    mode: ${quoteYamlString(item.mode)}`);
    rows.push(`    link: ${quoteYamlString(item.link ?? "")}`);
  }

  rows.push("---", "");
  return rows.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["ocr-json"]) usageAndExit();

  const wantJson = args.json === "true";
  const year = Number(args.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid --year: ${args.year}`);
  }

  const ocrJsonPath = path.resolve(process.cwd(), args["ocr-json"]);
  const rawBuffer = await fs.readFile(ocrJsonPath);
  const ocr = JSON.parse(decodeJsonBuffer(rawBuffer));
  const lines = Array.isArray(ocr?.lines) ? ocr.lines : [];
  if (!lines.length) throw new Error("OCR result has no lines. Try a clearer image.");

  const imageHeight = Number(ocr?.image?.height) || 0;
  const dateColumns = assignYears(pickDateColumns(lines, imageHeight), year);
  if (!dateColumns.length) throw new Error("Cannot detect date headers from image.");

  const items = extractItemsFromOcr(lines, dateColumns);
  if (!items.length) {
    throw new Error("No Fiona/Gladys schedule items detected. Try a larger or clearer source image.");
  }

  const weekStart = args["week-start"] || deriveWeekStartFromIso(items[0].startAt);
  const result = {
    weekStart,
    items,
    imagePath: ocr?.image?.path || "",
    ocrEngineLanguage: ocr?.engineLanguage || "",
    dateColumns,
    columnTimes: extractColumnTimes(lines, dateColumns),
    lineCount: lines.length,
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

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
    `ocr-debug-${path.basename(ocr?.image?.path || "image").replace(/\.[^.]+$/, "")}.json`,
  );

  await fs.mkdir(path.dirname(debugPath), { recursive: true });
  await fs.writeFile(debugPath, JSON.stringify(result, null, 2), "utf8");

  console.log(`Generated schedule file: ${outPath}`);
  console.log(`Detected items: ${items.length}`);
  console.log(`OCR debug file: ${debugPath}`);
  console.log("Note: OCR parsing is heuristic. Please manually proofread the generated file.");
}

await main();

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_SOURCE_MIDS,
  FIONA_MID,
  GLADYS_MID,
  OFFICIAL_MID,
  ROOM_BY_MID,
  downloadImage,
  fetchSpaceDynamics,
  formatDateForFilename,
  imageExtension,
  pickPinnedScheduleDynamic,
  pickReserveDynamics,
} from "./lib/bilibili-dynamics.mjs";

const execFileAsync = promisify(execFile);

const OCR_SCRIPT = path.resolve(process.cwd(), "scripts", "ocr-win.ps1");
const PARSER_SCRIPT = path.resolve(process.cwd(), "scripts", "extract-schedule-from-image.mjs");
const MAX_BUFFER = 16 * 1024 * 1024;
const OFFICIAL_CONFIDENCE = 0.6;
const SUMMARY_CONFIDENCE = 0.75;
const RESERVE_CONFIDENCE = 0.98;
const OFFICIAL_SLOT_OVERRIDES = {
  "1175041206816604163": {
    "2026-03-08|19:30|gladys": {
      title: "花与歌",
      category: "歌回",
      confidence: 0.92,
    },
  },
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }

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
      `  node scripts/import-schedule-from-pinned.mjs [--mid ${OFFICIAL_MID}] [--year 2026] [--json]`,
      "",
      "Example:",
      `  node scripts/import-schedule-from-pinned.mjs --mid ${FIONA_MID} --json`,
    ].join("\n"),
  );
  process.exit(1);
}

function resolvePowerShellBin() {
  return process.env.POWERSHELL_BIN || "powershell";
}

async function runTextCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, {
    cwd: process.cwd(),
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return String(stdout || "").trim();
}

async function runOcr(imagePath) {
  const raw = await runTextCommand(resolvePowerShellBin(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    OCR_SCRIPT,
    "-ImagePath",
    imagePath,
  ]);
  return JSON.parse(raw);
}

async function parseOcr(ocrJsonPath, year) {
  const raw = await runTextCommand(process.execPath, [
    PARSER_SCRIPT,
    "--ocr-json",
    ocrJsonPath,
    "--year",
    String(year),
    "--json",
  ]);
  return JSON.parse(raw);
}

function nowIso() {
  return new Date().toISOString();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toChinaParts(tsMs) {
  const local = new Date(tsMs + 8 * 60 * 60 * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

function currentChinaParts() {
  return toChinaParts(Date.now());
}

function addChinaDays(parts, deltaDays) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day);
  const next = new Date(base + deltaDays * 24 * 60 * 60 * 1000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function toDateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function toIsoStartAt(parts) {
  return `${toDateKey(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}:00+08:00`;
}

function dynamicUrl(dynamicId) {
  return dynamicId ? `https://t.bilibili.com/${dynamicId}` : "";
}

function inferCategory(title) {
  const normalized = String(title || "");
  if (/(杂谈|夜谈|聊天|茶话会)/.test(normalized)) return "杂谈";
  if (/(歌回|唱歌|KTV|K歌)/i.test(normalized)) return "歌回";
  if (/(联动|一起|小剧场)/.test(normalized)) return "联动";
  if (/(游戏|生化危机|梦魇)/.test(normalized)) return "游戏";
  return "";
}

function genericTitle(room) {
  if (room === "both") return "心宜 / 思诺直播";
  return room === "gladys" ? "思诺直播" : "心宜直播";
}

function isGenericTitle(title, room) {
  return String(title || "").trim() === genericTitle(room);
}

function slotKey(entry) {
  return `${entry.date}|${entry.time}|${entry.room}`;
}

function scoreEntry(entry) {
  let score = Number(entry.confidence || 0);
  if (!isGenericTitle(entry.title, entry.room)) score += 0.2;
  if (entry.category) score += 0.05;
  if (entry.mode) score += 0.05;
  score += Math.min(String(entry.title || "").length / 200, 0.15);
  return score;
}

function dedupeAutoEntries(entries) {
  const bySlot = new Map();
  for (const entry of entries) {
    const key = slotKey(entry);
    const existing = bySlot.get(key);
    if (!existing || scoreEntry(entry) > scoreEntry(existing)) {
      bySlot.set(key, entry);
    }
  }
  return [...bySlot.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

function createEntry({
  mid,
  dynamicId,
  sourceUrl,
  imageUrl,
  room,
  title,
  date,
  time,
  category,
  mode,
  confidence,
  importedAt,
  index,
}) {
  return {
    id: `auto-${mid}-${dynamicId || "dynamic"}-${String(index + 1).padStart(2, "0")}`,
    title,
    date,
    time,
    room,
    category: category || undefined,
    mode: mode || undefined,
    sourceType: "auto",
    sourceMid: mid,
    sourceDynamicId: dynamicId || "",
    sourceUrl: sourceUrl || undefined,
    imageUrl: imageUrl || undefined,
    confidence,
    importedAt,
    updatedAt: importedAt,
  };
}

function inferRoomFromText(text) {
  const value = String(text || "");
  const hasFiona = /(心宜|宜思|宜宝)/.test(value);
  const hasGladys = /(思诺|思诺snow)/.test(value);
  if (hasFiona && hasGladys) return "both";
  if (hasFiona) return "fiona";
  if (hasGladys) return "gladys";
  return null;
}

function parseOfficialSummaryEvents(meta, fallbackYear) {
  const nodes = Array.isArray(meta.richTextNodes) ? meta.richTextNodes : [];
  const summaryEvents = [];
  let buffer = "";

  for (const node of nodes) {
    const type = String(node?.type || "");
    const text = String(node?.text || "");

    if (type === "RICH_TEXT_NODE_TYPE_TEXT") {
      buffer += text;
      continue;
    }

    if (type === "RICH_TEXT_NODE_TYPE_AT") {
      const match = buffer.match(/(\d{1,2})月(\d{1,2})日的【([^】]+)】，是在\s*$/);
      if (match) {
        const month = Number(match[1]);
        const day = Number(match[2]);
        const title = String(match[3] || "").trim();
        const hostMid = String(node?.rid || "");
        const room = ROOM_BY_MID[hostMid] || inferRoomFromText(title);
        if (room) {
          summaryEvents.push({
            date: `${fallbackYear}-${pad2(month)}-${pad2(day)}`,
            room,
            title,
            category: inferCategory(title),
          });
        }
      }
    }

    buffer += text;
  }

  return summaryEvents;
}

function mergeOfficialSummaryEntries(baseEntries, summaryEvents, columnTimes, meta) {
  const entries = [...baseEntries];
  const importedAt = nowIso();

  for (const summary of summaryEvents) {
    const sameDateRoom = entries.filter((entry) => entry.date === summary.date && entry.room === summary.room);
    const genericMatch = sameDateRoom.find((entry) => isGenericTitle(entry.title, entry.room));
    if (genericMatch) {
      genericMatch.title = summary.title;
      genericMatch.category = summary.category || genericMatch.category;
      genericMatch.mode = "";
      genericMatch.confidence = Math.max(Number(genericMatch.confidence || 0), SUMMARY_CONFIDENCE);
      continue;
    }

    const exactTitleExists = sameDateRoom.some((entry) => entry.title === summary.title);
    if (exactTitleExists) continue;

    const times = Array.isArray(columnTimes?.[summary.date]) ? columnTimes[summary.date] : [];
    const usedTimes = new Set(sameDateRoom.map((entry) => entry.time));
    const time = times.find((candidate) => !usedTimes.has(candidate)) || times[0];
    if (!time) continue;

    entries.push(
      createEntry({
        mid: meta.authorMid,
        dynamicId: meta.id,
        sourceUrl: meta.sourceUrl,
        imageUrl: meta.primaryImageUrl,
        room: summary.room,
        title: summary.title,
        date: summary.date,
        time,
        category: summary.category,
        confidence: SUMMARY_CONFIDENCE,
        importedAt,
        index: entries.length,
      }),
    );
  }

  const overrides = OFFICIAL_SLOT_OVERRIDES[String(meta.id || "")] || {};
  const correctedEntries = dedupeAutoEntries(entries).map((entry) => {
    const override = overrides[slotKey(entry)];
    if (!override) return entry;
    const nextEntry = {
      ...entry,
      title: override.title || entry.title,
      category: override.category || entry.category,
      confidence: Math.max(Number(entry.confidence || 0), Number(override.confidence || 0)),
    };
    if ("mode" in override) nextEntry.mode = override.mode || "";
    else if (override.title && override.title !== entry.title) nextEntry.mode = "";
    return nextEntry;
  });

  for (const [key, override] of Object.entries(overrides)) {
    const [date, time, room] = key.split("|");
    if (!date || !time || !room) continue;
    if (!Array.isArray(columnTimes?.[date]) || !columnTimes[date].includes(time)) continue;
    if (correctedEntries.some((entry) => slotKey(entry) === key)) continue;

    correctedEntries.push(
      createEntry({
        mid: meta.authorMid,
        dynamicId: meta.id,
        sourceUrl: meta.sourceUrl,
        imageUrl: meta.primaryImageUrl,
        room,
        title: override.title || genericTitle(room),
        date,
        time,
        category: override.category || "",
        mode: Object.prototype.hasOwnProperty.call(override, "mode") ? (override.mode || "") : "",
        confidence: Math.max(SUMMARY_CONFIDENCE, Number(override.confidence || 0)),
        importedAt,
        index: correctedEntries.length,
      }),
    );
  }

  return dedupeAutoEntries(correctedEntries).map((entry, index) => ({
    ...entry,
    id: `auto-${meta.authorMid}-${meta.id || "dynamic"}-${String(index + 1).padStart(2, "0")}`,
  }));
}

async function importOfficialSchedule(mid, year) {
  const items = await fetchSpaceDynamics(mid, { maxPages: 3 });
  const meta = pickPinnedScheduleDynamic(items);
  if (!meta?.primaryImageUrl) {
    throw new Error("No pinned weekly schedule image found.");
  }

  const tsMs = (meta.pubTs || Math.floor(Date.now() / 1000)) * 1000;
  const folder = path.join(process.cwd(), "scripts", "_tmp", "schedule-images", mid);
  const fileName = `${formatDateForFilename(tsMs)}-${meta.id || "dynamic"}-01${imageExtension(meta.primaryImageUrl)}`;
  const imagePath = path.join(folder, fileName);
  await downloadImage(meta.primaryImageUrl, imagePath, mid);

  const ocrResult = await runOcr(imagePath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aa-schedule-import-"));
  const ocrJsonPath = path.join(tmpDir, "ocr.json");

  try {
    await fs.writeFile(ocrJsonPath, JSON.stringify(ocrResult), "utf8");
    const parsedResult = await parseOcr(ocrJsonPath, year);
    const importedAt = nowIso();

    const baseEntries = (Array.isArray(parsedResult.items) ? parsedResult.items : []).map((item, index) => {
      const room = item.member === "both" ? "both" : item.member === "gladys" ? "gladys" : "fiona";
      const title = String(item.title || "").trim() || genericTitle(item.member);
      const mode = String(item.mode || "").trim() || (room !== "both" && isGenericTitle(title, room) ? "2D" : "");
      return createEntry({
        mid,
        dynamicId: meta.id,
        sourceUrl: meta.sourceUrl,
        imageUrl: meta.primaryImageUrl,
        room,
        title,
        date: String(item.startAt || "").slice(0, 10),
        time: String(item.startAt || "").slice(11, 16),
        category: String(item.type || "").trim(),
        mode,
        confidence: isGenericTitle(title, item.member) ? OFFICIAL_CONFIDENCE : OFFICIAL_CONFIDENCE + 0.05,
        importedAt,
        index,
      });
    });

    const summaryEvents = parseOfficialSummaryEvents(meta, year);
    const entries = mergeOfficialSummaryEntries(baseEntries, summaryEvents, parsedResult.columnTimes || {}, meta);

    return {
      mid,
      dynamicId: meta.id,
      publishedAt: meta.publishedAt,
      pinned: !!meta.pinned,
      primaryImage: imagePath,
      imageUrls: meta.images || [],
      sourceUrl: meta.sourceUrl,
      weekStart: String(parsedResult.weekStart || ""),
      entries,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function parseReserveStartAt(text, pubTs) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";

  const pubParts = toChinaParts(pubTs * 1000);
  const relativeBase = currentChinaParts();
  let dateParts = null;
  let hour = 0;
  let minute = 0;

  let match = normalized.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    hour = Number(match[3]);
    minute = Number(match[4]);
    let year = pubParts.year;
    if (month < pubParts.month - 6) year += 1;
    if (month > pubParts.month + 6) year -= 1;
    dateParts = { year, month, day };
  }

  match = match || normalized.match(/(\d{1,2}):(\d{2})/);
  if (!dateParts && match) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    if (/明天/.test(normalized)) {
      dateParts = addChinaDays(relativeBase, 1);
    } else if (/后天/.test(normalized)) {
      dateParts = addChinaDays(relativeBase, 2);
    } else if (/(今天|今晚)/.test(normalized)) {
      dateParts = addChinaDays(relativeBase, 0);
    } else {
      const weekMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      const weekMatch = normalized.match(/周([日天一二三四五六])/);
      if (weekMatch) {
        const target = weekMap[weekMatch[1]];
        const current = relativeBase.weekday;
        let delta = target - current;
        if (delta < 0) delta += 7;
        if (delta === 0 && /明天/.test(normalized)) delta = 1;
        dateParts = addChinaDays(relativeBase, delta);
      }
    }
  }

  if (!dateParts) return "";
  return toIsoStartAt({ ...dateParts, hour, minute });
}

function splitReserveTitle(rawTitle) {
  const source = String(rawTitle || "").trim().replace(/^直播预约[:：]?\s*/, "");
  let mode = "";
  let title = source;

  const modeMatch = title.match(/^[【\[]([^】\]）)]+)[】\]）]\s*(.+)$/);
  if (modeMatch) {
    mode = modeMatch[1].trim();
    title = modeMatch[2].trim();
  }

  title = title.replace(/^[【\[]预约[】\]]/, "").replace(/^[【\[]/, "").trim();
  return { mode, title };
}

function keepRecentReserve(isoStartAt) {
  if (!isoStartAt) return false;
  const targetMs = Date.parse(isoStartAt);
  if (!Number.isFinite(targetMs)) return false;
  const now = Date.now();
  const minMs = now - 7 * 24 * 60 * 60 * 1000;
  return targetMs >= minMs;
}

async function importReserveDynamics(mid) {
  const room = ROOM_BY_MID[mid];
  if (!room) throw new Error(`MID ${mid} does not map to Fiona/Gladys.`);

  const items = await fetchSpaceDynamics(mid, { maxPages: 4 });
  const metas = pickReserveDynamics(items);
  if (!metas.length) {
    return {
      mid,
      dynamicId: "",
      publishedAt: "",
      pinned: false,
      imageUrls: [],
      sourceUrl: "",
      weekStart: "",
      entries: [],
    };
  }

  const importedAt = nowIso();
  const entries = [];

  for (const meta of metas) {
    const reserve = meta.reserve;
    const startAt = parseReserveStartAt(reserve?.desc1?.text || "", meta.pubTs);
    if (!keepRecentReserve(startAt)) continue;

    const { mode, title } = splitReserveTitle(reserve?.title || "");
    if (!title) continue;

    entries.push(
      createEntry({
        mid,
        dynamicId: meta.id,
        sourceUrl: meta.sourceUrl || dynamicUrl(meta.id),
        imageUrl: meta.primaryImageUrl,
        room,
        title,
        date: startAt.slice(0, 10),
        time: startAt.slice(11, 16),
        category: inferCategory(title),
        mode,
        confidence: RESERVE_CONFIDENCE,
        importedAt,
        index: entries.length,
      }),
    );
  }

  const latest = metas[0];
  return {
    mid,
    dynamicId: latest?.id || "",
    publishedAt: latest?.publishedAt || "",
    pinned: false,
    imageUrls: latest?.images || [],
    sourceUrl: latest?.sourceUrl || "",
    weekStart: "",
    entries: dedupeAutoEntries(entries).map((entry, index) => ({
      ...entry,
      id: `auto-${mid}-${entry.sourceDynamicId || "dynamic"}-${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

async function importForMid(mid, year) {
  if (mid === OFFICIAL_MID) return importOfficialSchedule(mid, year);
  if (mid === FIONA_MID || mid === GLADYS_MID) return importReserveDynamics(mid);
  throw new Error(`Unsupported --mid: ${mid}. Supported mids: ${DEFAULT_SOURCE_MIDS.join(", ")}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") usageAndExit();

  const mid = String(args.mid || args._[0] || OFFICIAL_MID).trim();
  const year = Number(args.year || new Date().getFullYear());
  const wantJson = args.json === "true";

  if (!/^\d{6,}$/.test(mid)) throw new Error(`Invalid --mid: ${mid}`);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid --year: ${args.year}`);
  }

  const result = await importForMid(mid, year);

  if (wantJson) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  console.log(`MID: ${result.mid}`);
  console.log(`Dynamic ID: ${result.dynamicId}`);
  if (result.weekStart) console.log(`WeekStart: ${result.weekStart}`);
  console.log(`Entries: ${Array.isArray(result.entries) ? result.entries.length : 0}`);
  console.log(`SourceUrl: ${result.sourceUrl}`);
}

await main();

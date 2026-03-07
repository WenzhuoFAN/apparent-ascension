import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { APIRoute } from "astro";

import { getAdminSession } from "../../../../lib/admin-auth";
import { CONTENT_KEYS, getContentByKey, setContentByKey } from "../../../../lib/content-store";

const execFileAsync = promisify(execFile);
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const IMPORT_SCRIPT = path.resolve(process.cwd(), "scripts", "import-schedule-from-pinned.mjs");
const DEFAULT_MIDS = ["3493085336046382", "3537115310721181", "3537115310721781"];

type ScheduleEntry = {
  id: string;
  title: string;
  date: string;
  time: string;
  room: "fiona" | "gladys" | "both";
  sourceType: "manual" | "auto";
  sourceDynamicId?: string;
  confidence?: number;
};

type ImportBody = {
  mids?: unknown;
  year?: unknown;
};

function normalizeMids(input: unknown) {
  const rawList = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : DEFAULT_MIDS;

  const mids = rawList
    .map((item) => String(item || "").trim())
    .filter((mid) => /^\d{6,}$/.test(mid));

  return mids.length ? [...new Set(mids)] : DEFAULT_MIDS;
}

function normalizeYear(input: unknown) {
  const year = Number(input || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${input}`);
  }
  return year;
}

async function runImport(mid: string, year: number) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [IMPORT_SCRIPT, "--mid", mid, "--year", String(year), "--json"],
    {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return JSON.parse(String(stdout || "").trim());
}

function slotKey(entry: Pick<ScheduleEntry, "date" | "time" | "room">) {
  return `${entry.date}|${entry.time}|${entry.room}`;
}

function scoreEntry(entry: ScheduleEntry) {
  let score = Number(entry.confidence || 0);
  const title = String(entry.title || "").trim();
  const genericTitle =
    entry.room === "both" ? "心宜 / 思诺直播" : entry.room === "gladys" ? "思诺直播" : "心宜直播";
  if (title && title !== genericTitle) score += 0.25;
  score += Math.min(title.length / 200, 0.15);
  return score;
}

function mergeEntries(current: ScheduleEntry[], importedEntries: ScheduleEntry[]) {
  const importedDynamicIds = new Set(
    importedEntries
      .map((entry) => String(entry.sourceDynamicId || "").trim())
      .filter(Boolean),
  );

  const next = current.filter((entry) => {
    if (entry.sourceType !== "auto") return true;
    const dynamicId = String(entry.sourceDynamicId || "").trim();
    if (!dynamicId) return true;
    return !importedDynamicIds.has(dynamicId);
  });

  const manualSlots = new Set(next.filter((entry) => entry.sourceType !== "auto").map((entry) => slotKey(entry)));
  const autoBySlot = new Map<string, ScheduleEntry>();
  for (const entry of next) {
    if (entry.sourceType !== "auto") continue;
    autoBySlot.set(slotKey(entry), entry);
  }

  for (const entry of importedEntries) {
    const key = slotKey(entry);
    if (manualSlots.has(key)) continue;

    const existing = autoBySlot.get(key);
    if (!existing || scoreEntry(entry) > scoreEntry(existing)) {
      autoBySlot.set(key, entry);
    }
  }

  return [
    ...next.filter((entry) => entry.sourceType !== "auto"),
    ...[...autoBySlot.values()].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`)),
  ];
}

export const POST: APIRoute = async (context) => {
  try {
    const session = await getAdminSession(context);
    if (!session) {
      return new Response(JSON.stringify({ ok: false, message: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const body = (await context.request.json().catch(() => ({}))) as ImportBody;
    const mids = normalizeMids(body.mids);
    const year = normalizeYear(body.year);

    const current = (await getContentByKey(CONTENT_KEYS.schedule)) as ScheduleEntry[];
    let merged = Array.isArray(current) ? [...current] : [];

    const sources = [];
    let importedCount = 0;

    for (const mid of mids) {
      try {
        const result = await runImport(mid, year);
        const importedEntries = Array.isArray(result?.entries) ? result.entries : [];
        merged = mergeEntries(merged, importedEntries);
        importedCount += importedEntries.length;
        sources.push({
          mid,
          ok: true,
          dynamicId: result?.dynamicId || "",
          weekStart: result?.weekStart || "",
          importedCount: importedEntries.length,
          sourceUrl: result?.sourceUrl || "",
        });
      } catch (err) {
        sources.push({
          mid,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successful = sources.filter((source) => source.ok);
    if (!successful.length) {
      return new Response(JSON.stringify({ ok: false, message: "No imports succeeded", sources }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    const data = await setContentByKey(CONTENT_KEYS.schedule, merged);
    return new Response(
      JSON.stringify({
        ok: true,
        data,
        importedCount,
        sources,
      }),
      {
        status: 200,
        headers: jsonHeaders,
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: jsonHeaders,
      },
    );
  }
};

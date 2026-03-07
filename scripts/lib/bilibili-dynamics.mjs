import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const OFFICIAL_MID = "3493085336046382";
export const FIONA_MID = "3537115310721181";
export const GLADYS_MID = "3537115310721781";
export const DEFAULT_SOURCE_MIDS = [OFFICIAL_MID, FIONA_MID, GLADYS_MID];

export const ROOM_BY_MID = {
  [FIONA_MID]: "fiona",
  [GLADYS_MID]: "gladys",
};

const FEED_API = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space";
const NAV_API = "https://api.bilibili.com/x/web-interface/nav";
const COOKIE_FILE = path.resolve(process.cwd(), ".bili-cookie.txt");
const FEATURES =
  "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,avatarAutoTheme,sunflowerStyle,cardsEnhance,eva3CardOpus,eva3CardVideo,eva3CardComment,eva3CardUser";
const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32,
  15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

export function normalizeBiliUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}

export async function readCookieFromFile(filePath = COOKIE_FILE) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

function baseHeaders(mid, cookie = "") {
  const headers = {
    "user-agent": "Mozilla/5.0",
    referer: `https://space.bilibili.com/${mid}/dynamic`,
    origin: "https://space.bilibili.com",
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function fetchJson(url, mid, cookie = "") {
  const res = await fetch(url, {
    headers: baseHeaders(mid, cookie),
  });
  if (!res.ok) {
    if (res.status === 412) {
      throw new Error(`HTTP 412 from Bilibili API. Please set BILI_COOKIE and retry. URL: ${url}`);
    }
    throw new Error(`HTTP ${res.status} ${url}`);
  }

  const json = await res.json();
  if (json?.code !== 0) {
    if (json?.code === -101) {
      throw new Error("API error: -101 账号未登录。请先设置 BILI_COOKIE 后重试。");
    }
    throw new Error(`API error: ${json?.code} ${json?.message || ""}`);
  }

  return json?.data ?? {};
}

function keyFromUrl(url) {
  if (!url) return "";
  const clean = String(url).split("?")[0];
  const file = clean.substring(clean.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function getMixinKey(orig) {
  return WBI_MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join("").slice(0, 32);
}

function sanitizeWbiValue(value) {
  return String(value).replace(/[!'()*]/g, "");
}

function buildSignedQuery(params, mixinKey) {
  const signedParams = {
    ...params,
    wts: Math.floor(Date.now() / 1000),
  };

  const query = Object.keys(signedParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(sanitizeWbiValue(signedParams[key]))}`)
    .join("&");

  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

async function getWbiMixinKey(mid, cookie = "") {
  const data = await fetchJson(NAV_API, mid, cookie);
  const imgKey = keyFromUrl(data?.wbi_img?.img_url);
  const subKey = keyFromUrl(data?.wbi_img?.sub_url);
  const raw = `${imgKey}${subKey}`;
  if (!raw || raw.length < 64) {
    throw new Error("Failed to fetch WBI key from /x/web-interface/nav");
  }
  return getMixinKey(raw);
}

export function dynamicId(item) {
  return (
    item?.id_str ||
    item?.idStr ||
    item?.basic?.comment_id_str ||
    item?.basic?.comment_id?.toString?.() ||
    ""
  );
}

export function dynamicPubTs(item) {
  return Number(item?.modules?.module_author?.pub_ts || 0);
}

export function dynamicUrl(itemOrId) {
  const id = typeof itemOrId === "string" ? itemOrId : dynamicId(itemOrId);
  return id ? `https://t.bilibili.com/${id}` : "";
}

export function dynamicSummaryText(item) {
  return (
    item?.modules?.module_dynamic?.major?.opus?.summary?.text ||
    item?.modules?.module_dynamic?.desc?.text ||
    item?.modules?.module_dynamic?.major?.opus?.title ||
    ""
  );
}

export function dynamicRichTextNodes(item) {
  return item?.modules?.module_dynamic?.major?.opus?.summary?.rich_text_nodes || [];
}

export function dynamicAuthorMid(item) {
  return String(item?.modules?.module_author?.mid || "");
}

export function dynamicAuthorName(item) {
  return String(item?.modules?.module_author?.name || "");
}

export function isPinned(item) {
  const text = String(item?.modules?.module_tag?.text || item?.modules?.module_tag?.tag_text || "");
  return /置顶/i.test(text);
}

export function hasScheduleKeyword(text) {
  return /(日程|日历|直播日历|直播表|直播安排|周表|calendar|schedule)/i.test(String(text || ""));
}

export function extractImageUrls(item) {
  const urls = [];
  const major = item?.modules?.module_dynamic?.major;

  if (Array.isArray(major?.draw?.items)) {
    for (const img of major.draw.items) {
      const url = normalizeBiliUrl(img?.src || img?.url || img?.dynamic_url || "");
      if (url) urls.push(url);
    }
  }

  if (Array.isArray(major?.opus?.pics)) {
    for (const img of major.opus.pics) {
      const url = normalizeBiliUrl(img?.url || img?.src || "");
      if (url) urls.push(url);
    }
  }

  return [...new Set(urls)];
}

export function extractReserve(item) {
  const additional = item?.modules?.module_dynamic?.additional;
  if (!additional || additional.type !== "ADDITIONAL_TYPE_RESERVE") return null;
  if (!additional.reserve) return null;
  return additional.reserve;
}

export function summarizeDynamic(item) {
  const id = dynamicId(item);
  const pubTs = dynamicPubTs(item);
  const images = extractImageUrls(item);
  const reserve = extractReserve(item);

  return {
    id,
    pubTs,
    publishedAt: pubTs ? new Date(pubTs * 1000).toISOString() : "",
    pinned: isPinned(item),
    text: dynamicSummaryText(item),
    richTextNodes: dynamicRichTextNodes(item),
    images,
    primaryImageUrl: images[0] || "",
    reserve,
    sourceUrl: dynamicUrl(id),
    authorMid: dynamicAuthorMid(item),
    authorName: dynamicAuthorName(item),
    raw: item,
  };
}

export async function fetchSpaceDynamics(mid, { maxPages = 3, cookie = "" } = {}) {
  const actualCookie = cookie || process.env.BILI_COOKIE || (await readCookieFromFile());
  const mixinKey = await getWbiMixinKey(mid, actualCookie);

  const allItems = [];
  let offset = "";

  for (let page = 0; page < maxPages; page += 1) {
    const signedQuery = buildSignedQuery(
      {
        offset,
        host_mid: mid,
        timezone_offset: String(new Date().getTimezoneOffset()),
        platform: "web",
        features: FEATURES,
        web_location: "333.1387",
      },
      mixinKey,
    );

    const data = await fetchJson(`${FEED_API}?${signedQuery}`, mid, actualCookie);
    const items = Array.isArray(data?.items) ? data.items : [];
    allItems.push(...items);

    const hasMore = Boolean(data?.has_more);
    const nextOffset = String(data?.offset || "");
    if (!hasMore || !nextOffset) break;
    offset = nextOffset;
  }

  return allItems;
}

export function pickPinnedScheduleDynamic(items) {
  const withMeta = items.map((item) => summarizeDynamic(item));

  const pinnedWithImage = withMeta.find((item) => item.pinned && item.images.length > 0);
  if (pinnedWithImage) return pinnedWithImage;

  const pinnedSchedule = withMeta.find((item) => item.pinned && hasScheduleKeyword(item.text) && item.images.length > 0);
  if (pinnedSchedule) return pinnedSchedule;

  const scheduleImage = withMeta.find((item) => hasScheduleKeyword(item.text) && item.images.length > 0);
  if (scheduleImage) return scheduleImage;

  return withMeta.find((item) => item.images.length > 0) ?? null;
}

export function pickReserveDynamics(items) {
  return items
    .map((item) => summarizeDynamic(item))
    .filter((item) => item.reserve)
    .sort((a, b) => b.pubTs - a.pubTs);
}

export async function downloadImage(url, outPath, mid, cookie = "") {
  const actualCookie = cookie || process.env.BILI_COOKIE || (await readCookieFromFile());
  const res = await fetch(normalizeBiliUrl(url), {
    headers: baseHeaders(mid, actualCookie),
  });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

export function imageExtension(url) {
  try {
    const ext = path.extname(new URL(normalizeBiliUrl(url)).pathname).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") return ext;
  } catch {
    // ignore
  }
  return ".jpg";
}

export function formatDateForFilename(tsMs) {
  const dt = new Date(tsMs || Date.now());
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  const hour = String(dt.getHours()).padStart(2, "0");
  const minute = String(dt.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}`;
}

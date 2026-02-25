import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_MID = "3493085336046382";
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

async function readCookieFromFile(filePath = COOKIE_FILE) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

function normalizeBiliUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

function dynamicId(item) {
  return (
    item?.id_str ||
    item?.idStr ||
    item?.basic?.comment_id_str ||
    item?.basic?.comment_id?.toString?.() ||
    ""
  );
}

function dynamicText(item) {
  return (
    item?.modules?.module_dynamic?.desc?.text ||
    item?.modules?.module_dynamic?.major?.opus?.title ||
    ""
  );
}

function dynamicPubTs(item) {
  return Number(item?.modules?.module_author?.pub_ts || 0);
}

function isPinned(item) {
  const tag = item?.modules?.module_tag?.text || item?.modules?.module_tag?.tag_text || "";
  return /置顶/.test(tag);
}

function hasScheduleKeyword(text) {
  return /(日程|日历|直播日历|直播历|周表|calendar)/i.test(String(text || ""));
}

function extractImageUrls(item) {
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

function imageExtension(url) {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp") return ext;
    return ".jpg";
  } catch {
    return ".jpg";
  }
}

function formatDateForFilename(tsMs) {
  const dt = new Date(tsMs || Date.now());
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${y}${m}${d}-${hh}${mm}`;
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
      throw new Error(
        `HTTP 412 from Bilibili API. Please set BILI_COOKIE and retry. URL: ${url}`
      );
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
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sanitizeWbiValue(signedParams[k]))}`)
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

function pickCandidate(items) {
  const withMeta = items.map((item) => ({
    item,
    id: dynamicId(item),
    text: dynamicText(item),
    pinned: isPinned(item),
    images: extractImageUrls(item),
    pubTs: dynamicPubTs(item),
  }));

  const pinnedWithImage = withMeta.find((x) => x.pinned && x.images.length > 0);
  if (pinnedWithImage) return pinnedWithImage;

  const pinnedSchedule = withMeta.find((x) => x.pinned && hasScheduleKeyword(x.text) && x.images.length > 0);
  if (pinnedSchedule) return pinnedSchedule;

  const scheduleImage = withMeta.find((x) => hasScheduleKeyword(x.text) && x.images.length > 0);
  if (scheduleImage) return scheduleImage;

  return withMeta.find((x) => x.images.length > 0) ?? null;
}

async function downloadImage(url, outPath, mid, cookie = "") {
  const res = await fetch(url, {
    headers: baseHeaders(mid, cookie),
  });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mid = args.mid || args._[0] || DEFAULT_MID;
  const maxPages = Number(args["max-pages"] || 3);
  const outDir = path.resolve(process.cwd(), args["out-dir"] || path.join("scripts", "_tmp", "schedule-images"));
  const cookie = args.cookie || process.env.BILI_COOKIE || (await readCookieFromFile());
  const wantJson = args.json === "true" || args._.includes("json");
  const mixinKey = await getWbiMixinKey(mid, cookie);

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
      mixinKey
    );
    const data = await fetchJson(`${FEED_API}?${signedQuery}`, mid, cookie);
    const items = Array.isArray(data?.items) ? data.items : [];
    allItems.push(...items);

    const hasMore = Boolean(data?.has_more);
    const nextOffset = data?.offset || "";
    if (!hasMore || !nextOffset) break;
    offset = String(nextOffset);
  }

  if (!allItems.length) throw new Error("No dynamic items returned.");

  const candidate = pickCandidate(allItems);
  if (!candidate) throw new Error("No dynamic with image found.");

  const tsMs = (candidate.pubTs || Math.floor(Date.now() / 1000)) * 1000;
  const folder = path.join(outDir, mid);
  await fs.mkdir(folder, { recursive: true });

  const downloaded = [];
  for (let i = 0; i < candidate.images.length; i += 1) {
    const imgUrl = candidate.images[i];
    const ext = imageExtension(imgUrl);
    const fileName = `${formatDateForFilename(tsMs)}-${candidate.id || "dynamic"}-${String(i + 1).padStart(2, "0")}${ext}`;
    const filePath = path.join(folder, fileName);
    await downloadImage(imgUrl, filePath, mid, cookie);
    downloaded.push(filePath);
  }

  const result = {
    mid,
    dynamicId: candidate.id,
    pinned: candidate.pinned,
    publishedAt: new Date(tsMs).toISOString(),
    text: candidate.text,
    imageUrls: candidate.images,
    downloaded,
    primaryImage: downloaded[0] || "",
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result));
    return;
  }

  console.log(`Dynamic ID: ${result.dynamicId}`);
  console.log(`Pinned: ${result.pinned ? "yes" : "no"}`);
  console.log(`PublishedAt: ${result.publishedAt}`);
  console.log(`Downloaded: ${result.downloaded.length}`);
  console.log(`PrimaryImage: ${result.primaryImage}`);
}

await main();

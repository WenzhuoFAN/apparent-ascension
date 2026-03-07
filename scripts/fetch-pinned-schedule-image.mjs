import path from "node:path";

import {
  OFFICIAL_MID,
  downloadImage,
  fetchSpaceDynamics,
  formatDateForFilename,
  imageExtension,
  pickPinnedScheduleDynamic,
} from "./lib/bilibili-dynamics.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mid = String(args.mid || args._[0] || OFFICIAL_MID).trim();
  const maxPages = Number(args["max-pages"] || 3);
  const wantJson = args.json === "true" || args._.includes("json");
  const outDir = path.resolve(process.cwd(), args["out-dir"] || path.join("scripts", "_tmp", "schedule-images"));

  const items = await fetchSpaceDynamics(mid, { maxPages });
  if (!items.length) throw new Error("No dynamic items returned.");

  const candidate = pickPinnedScheduleDynamic(items);
  if (!candidate) throw new Error("No dynamic with image found.");

  const tsMs = (candidate.pubTs || Math.floor(Date.now() / 1000)) * 1000;
  const folder = path.join(outDir, mid);
  const downloaded = [];

  for (let i = 0; i < candidate.images.length; i += 1) {
    const imageUrl = candidate.images[i];
    const ext = imageExtension(imageUrl);
    const fileName = `${formatDateForFilename(tsMs)}-${candidate.id || "dynamic"}-${String(i + 1).padStart(2, "0")}${ext}`;
    const filePath = path.join(folder, fileName);
    await downloadImage(imageUrl, filePath, mid);
    downloaded.push(filePath);
  }

  const result = {
    mid,
    dynamicId: candidate.id,
    pinned: candidate.pinned,
    publishedAt: candidate.publishedAt,
    authorMid: candidate.authorMid,
    authorName: candidate.authorName,
    text: candidate.text,
    richTextNodes: candidate.richTextNodes,
    imageUrls: candidate.images,
    downloaded,
    primaryImage: downloaded[0] || "",
    sourceUrl: candidate.sourceUrl,
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

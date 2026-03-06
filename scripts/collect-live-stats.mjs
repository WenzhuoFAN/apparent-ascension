import fs from "node:fs/promises";
import path from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { Pool } from "pg";

const MEMBERS = [
  { key: "fiona", mid: "3537115310721181" },
  { key: "gladys", mid: "3537115310721781" },
];

const DB_CONTENT_KEY = "stats.live.sessions.v1";
const SESSION_LIMIT = 2000;
const POLL_INTERVAL_MS = readPositiveInt(process.env.LIVE_POLL_INTERVAL_MS, 20_000);
const ROOM_INFO_INTERVAL_MS = readPositiveInt(process.env.LIVE_ROOM_INFO_INTERVAL_MS, 15_000);
const FLUSH_INTERVAL_MS = readPositiveInt(process.env.LIVE_FLUSH_INTERVAL_MS, 60_000);
const FETCH_TIMEOUT_MS = readPositiveInt(process.env.LIVE_FETCH_TIMEOUT_MS, 8_000);
const WS_HEARTBEAT_INTERVAL_MS = 30_000;
const WS_RECONNECT_DELAY_MS = readPositiveInt(process.env.LIVE_WS_RECONNECT_DELAY_MS, 3_000);

const ROOM_INFO_OLD_API = "https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=";
const ROOM_INFO_API = "https://api.live.bilibili.com/room/v1/Room/get_info?id=";
const DANMU_CONF_API = "https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=";

function readPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function clampText(value, maxLen) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseLooseCount(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
  }

  const text = clampText(value, 64).replace(/,/g, "");
  if (!text) return 0;

  const withUnit = text.match(/^(\d+(?:\.\d+)?)(万|亿)$/);
  if (withUnit) {
    const base = Number(withUnit[1]);
    if (!Number.isFinite(base) || base < 0) return 0;
    const multiplier = withUnit[2] === "亿" ? 100_000_000 : 10_000;
    return Math.floor(base * multiplier);
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);

  const digits = text.replace(/[^\d]/g, "");
  if (!digits) return 0;
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

function toIsoIfValid(value) {
  const text = clampText(value, 64);
  if (!text) return "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function parseBiliLiveTimeToIso(value) {
  const text = clampText(value, 32);
  if (!text || text === "0000-00-00 00:00:00") return "";
  const normalized = `${text.replace(" ", "T")}+08:00`;
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString();
}

function buildSessionId(memberKey, roomId, startedAt) {
  const compact = clampText(startedAt, 64).replace(/\D/g, "").slice(0, 14) || String(Date.now());
  return `${memberKey}-${roomId}-${compact}`;
}

function packWs(bodyText, operation) {
  const body = Buffer.from(bodyText, "utf8");
  const header = Buffer.alloc(16);
  header.writeInt32BE(16 + body.length, 0);
  header.writeInt16BE(16, 4);
  header.writeInt16BE(1, 6);
  header.writeInt32BE(operation, 8);
  header.writeInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

function unpackPackets(buffer) {
  const out = [];
  let offset = 0;

  while (offset + 16 <= buffer.length) {
    const packetLen = buffer.readInt32BE(offset);
    if (packetLen < 16 || offset + packetLen > buffer.length) break;

    const headerLen = buffer.readInt16BE(offset + 4);
    const protocolVersion = buffer.readInt16BE(offset + 6);
    const operation = buffer.readInt32BE(offset + 8);
    const body = buffer.subarray(offset + headerLen, offset + packetLen);

    if ((protocolVersion === 2 || protocolVersion === 3) && body.length) {
      try {
        const decompressed = protocolVersion === 2 ? inflateSync(body) : brotliDecompressSync(body);
        out.push(...unpackPackets(decompressed));
      } catch {
        // Ignore malformed compressed packets and continue.
      }
    } else {
      out.push({ operation, protocolVersion, body });
    }

    offset += packetLen;
  }

  return out;
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
  }
  return Buffer.alloc(0);
}

function parseCommandFromBody(body) {
  const text = body.toString("utf8").replace(/\0+$/g, "");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
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

function safeConnInfo(url) {
  try {
    const u = new URL(url);
    return {
      host: u.host,
      database: u.pathname.replace(/^\//, ""),
      user: decodeURIComponent(u.username || ""),
    };
  } catch {
    return null;
  }
}

async function loadDotEnvIfPresent() {
  const envPath = path.join(process.cwd(), ".env");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const matched = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!matched) continue;

    const key = matched[1];
    let value = matched[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function isLocalConnection(url) {
  return /localhost|127\.0\.0\.1/i.test(url);
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

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSessionRows(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  const seen = new Set();

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;

    const id = clampText(item.id, 120) || `legacy-${i + 1}`;
    if (seen.has(id)) continue;

    const member = item.member === "fiona" || item.member === "gladys" ? item.member : null;
    const mid = clampText(item.mid, 24);
    const roomId = toNonNegativeInt(item.roomId);
    const title = clampText(item.title, 140);
    const startedAt = toIsoIfValid(item.startedAt);
    const updatedAt = toIsoIfValid(item.updatedAt);
    if (!member || !mid || !roomId || !title || !startedAt || !updatedAt) continue;

    seen.add(id);
    rows.push({
      id,
      member,
      mid,
      roomId,
      statsVersion: toNonNegativeInt(item.statsVersion, 1),
      title,
      startedAt,
      endedAt: toIsoIfValid(item.endedAt) || undefined,
      durationSec: toNonNegativeInt(item.durationSec),
      danmakuCount: toNonNegativeInt(item.danmakuCount),
      peakRealtimeViewers: toNonNegativeInt(item.peakRealtimeViewers),
      peakPopularity: toNonNegativeInt(item.peakPopularity),
      revenueCny: roundMoney(item.revenueCny),
      superChatRevenueCny: roundMoney(item.superChatRevenueCny),
      giftRevenueCny: roundMoney(item.giftRevenueCny),
      updatedAt,
      status: item.status === "live" ? "live" : "ended",
    });
  }

  rows.sort((a, b) => {
    const byStart = b.startedAt.localeCompare(a.startedAt);
    if (byStart !== 0) return byStart;
    return a.member.localeCompare(b.member);
  });

  return rows.slice(0, SESSION_LIMIT);
}

class LiveSessionStore {
  constructor(pool) {
    this.pool = pool;
    this.rowsById = new Map();
    this.dirty = false;
    this.flushing = false;
    this.flushRequested = false;
  }

  async load() {
    const result = await this.pool.query("SELECT content_json FROM site_content WHERE content_key = $1 LIMIT 1", [
      DB_CONTENT_KEY,
    ]);
    if (!result.rowCount) return;

    const rows = normalizeSessionRows(result.rows[0].content_json);
    for (const row of rows) {
      this.rowsById.set(row.id, row);
    }
  }

  upsert(row) {
    this.rowsById.set(row.id, row);
    this.dirty = true;
  }

  getById(id) {
    return this.rowsById.get(id) ?? null;
  }

  async flush(force = false) {
    if (!force && !this.dirty) return;
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }

    this.flushing = true;
    try {
      do {
        this.flushRequested = false;
        if (!force && !this.dirty) continue;

        const rows = [...this.rowsById.values()];
        rows.sort((a, b) => {
          const byStart = b.startedAt.localeCompare(a.startedAt);
          if (byStart !== 0) return byStart;
          return a.member.localeCompare(b.member);
        });
        const limited = rows.slice(0, SESSION_LIMIT);

        await this.pool.query(
          `
            INSERT INTO site_content (content_key, content_json, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (content_key)
            DO UPDATE SET content_json = EXCLUDED.content_json, updated_at = NOW()
          `,
          [DB_CONTENT_KEY, JSON.stringify(limited)],
        );

        this.dirty = false;
      } while (this.flushRequested);
    } finally {
      this.flushing = false;
    }
  }
}

class LiveSessionCollector {
  constructor({ member, roomId, title, startedAtHint, store }) {
    this.member = member;
    this.mid = member.mid;
    this.roomId = roomId;
    this.title = clampText(title, 140) || `${member.key} live`;
    this.startedAt = startedAtHint || nowIso();
    this.store = store;

    this.id = buildSessionId(member.key, roomId, this.startedAt);
    this.running = false;
    this.endedAt = "";
    this.danmakuCount = 0;
    this.peakRealtimeViewers = 0;
    this.peakPopularity = 0;
    this.superChatRevenueCny = 0;
    this.giftRevenueCny = 0;

    this.giftSeen = new Set();
    this.scSeen = new Set();
    this.guardSeen = new Set();

    this.ws = null;
    this.heartbeatTimer = null;
    this.roomInfoTimer = null;
    this.flushTimer = null;
    this.reconnectTimer = null;
  }

  log(message, ...rest) {
    console.log(`${nowIso()} [live:${this.member.key}] ${message}`, ...rest);
  }

  snapshot() {
    const startMs = Date.parse(this.startedAt);
    const endMs = this.endedAt ? Date.parse(this.endedAt) : Date.now();
    const durationSec =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? Math.floor((endMs - startMs) / 1000)
        : 0;

    const superChatRevenueCny = roundMoney(this.superChatRevenueCny);
    const giftRevenueCny = roundMoney(this.giftRevenueCny);

    return {
      id: this.id,
      member: this.member.key,
      mid: this.mid,
      roomId: this.roomId,
      statsVersion: 2,
      title: this.title,
      startedAt: this.startedAt,
      endedAt: this.endedAt || undefined,
      durationSec,
      danmakuCount: this.danmakuCount,
      peakRealtimeViewers: this.peakRealtimeViewers,
      peakPopularity: this.peakPopularity,
      revenueCny: roundMoney(superChatRevenueCny + giftRevenueCny),
      superChatRevenueCny,
      giftRevenueCny,
      updatedAt: nowIso(),
      status: this.running ? "live" : "ended",
    };
  }

  async start() {
    if (this.running) return;

    // Resume counters for the same live session ID to avoid data resets after restarts.
    const existing = this.store.getById(this.id);
    if (existing && existing.member === this.member.key && existing.roomId === this.roomId) {
      const existingStatsVersion = toNonNegativeInt(existing.statsVersion, 1);
      this.danmakuCount = Math.max(this.danmakuCount, toNonNegativeInt(existing.danmakuCount, 0));
      if (existingStatsVersion >= 2) {
        this.peakRealtimeViewers = Math.max(
          this.peakRealtimeViewers,
          toNonNegativeInt(existing.peakRealtimeViewers, 0),
        );
      }
      this.peakPopularity = Math.max(this.peakPopularity, toNonNegativeInt(existing.peakPopularity, 0));
      this.superChatRevenueCny = Math.max(this.superChatRevenueCny, roundMoney(existing.superChatRevenueCny));
      this.giftRevenueCny = Math.max(this.giftRevenueCny, roundMoney(existing.giftRevenueCny));
      if (existing.title) this.title = clampText(existing.title, 140);
    }

    this.running = true;
    this.log(`collector started (roomId=${this.roomId})`);

    await this.refreshRoomInfo({ adoptStartTime: true });
    this.store.upsert(this.snapshot());
    await this.store.flush();

    this.roomInfoTimer = setInterval(() => {
      void this.refreshRoomInfo({ adoptStartTime: false });
    }, ROOM_INFO_INTERVAL_MS);

    this.flushTimer = setInterval(() => {
      this.store.upsert(this.snapshot());
      void this.store.flush();
    }, FLUSH_INTERVAL_MS);

    await this.connectWebSocket();
  }

  updateFromStatus(status) {
    if (status?.title) this.title = clampText(status.title, 140);
  }

  async stop(reason) {
    if (!this.running) return;
    this.running = false;
    this.endedAt = nowIso();

    if (this.roomInfoTimer) clearInterval(this.roomInfoTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.roomInfoTimer = null;
    this.flushTimer = null;
    this.reconnectTimer = null;

    this.closeWebSocket();

    this.store.upsert(this.snapshot());
    await this.store.flush(true);

    this.log(`collector stopped (${reason})`);
  }

  async refreshRoomInfo({ adoptStartTime }) {
    const json = await fetchJson(`${ROOM_INFO_API}${this.roomId}`);
    if (!json || json.code !== 0 || !json.data) return;

    const data = json.data;
    const online = toNonNegativeInt(data.online, 0);
    if (online > this.peakPopularity) this.peakPopularity = online;

    if (data.title) this.title = clampText(data.title, 140);

    if (adoptStartTime) {
      const liveStartedAt = parseBiliLiveTimeToIso(data.live_time);
      if (liveStartedAt) this.startedAt = liveStartedAt;
    }

  }

  closeWebSocket() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    try {
      ws.close();
    } catch {
      // Ignore close failures.
    }
  }

  scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWebSocket();
    }, WS_RECONNECT_DELAY_MS);
  }

  async connectWebSocket() {
    if (!this.running) return;

    const conf = await fetchJson(`${DANMU_CONF_API}${this.roomId}`);
    if (!conf || conf.code !== 0 || !conf.data?.token) {
      this.scheduleReconnect();
      return;
    }

    const hostNode = Array.isArray(conf.data.host_server_list) ? conf.data.host_server_list[0] : null;
    const host = clampText(hostNode?.host || conf.data.host, 120);
    const wssPort = toNonNegativeInt(hostNode?.wss_port || 443, 443);
    const endpoint = wssPort && wssPort !== 443 ? `wss://${host}:${wssPort}/sub` : `wss://${host}/sub`;

    let ws;
    try {
      ws = new WebSocket(endpoint);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws = ws;

    ws.addEventListener("open", () => {
      if (!this.running || ws !== this.ws) return;

      const authBody = JSON.stringify({
        uid: 0,
        roomid: this.roomId,
        protover: 3,
        platform: "web",
        type: 2,
        key: conf.data.token,
      });

      try {
        ws.send(packWs(authBody, 7));
        ws.send(packWs("[object Object]", 2));
      } catch {
        // Ignore transient send failures.
      }

      this.heartbeatTimer = setInterval(() => {
        if (!this.running || ws !== this.ws) return;
        try {
          ws.send(packWs("[object Object]", 2));
        } catch {
          // Ignore heartbeat send failures.
        }
      }, WS_HEARTBEAT_INTERVAL_MS);
    });

    ws.addEventListener("message", async (event) => {
      if (!this.running || ws !== this.ws) return;

      const raw = await toBuffer(event.data);
      if (!raw.length) return;

      const packets = unpackPackets(raw);
      for (const packet of packets) {
        if (packet.operation === 3 && packet.body.length >= 4) {
          const popularity = packet.body.readInt32BE(0);
          if (popularity > this.peakPopularity) this.peakPopularity = popularity;
          continue;
        }

        if (packet.operation !== 5 || !packet.body.length) continue;

        const command = parseCommandFromBody(packet.body);
        if (!command) continue;
        this.handleCommand(command);
      }
    });

    ws.addEventListener("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;

      if (ws === this.ws) {
        this.ws = null;
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // Errors are handled by "close" and reconnect logic.
    });
  }

  handleCommand(command) {
    const cmd = clampText(command?.cmd, 120);
    if (!cmd) return;

    const base = cmd.split(":")[0];
    if (base === "DANMU_MSG") {
      this.danmakuCount += 1;
      return;
    }

    if (base === "WATCHED_CHANGE") {
      const watched = parseLooseCount(command?.data?.num);
      if (watched > this.peakPopularity) this.peakPopularity = watched;
      return;
    }

    if (base === "ONLINE_RANK_COUNT") {
      const watched = parseLooseCount(command?.data?.count);
      if (watched > this.peakRealtimeViewers) this.peakRealtimeViewers = watched;
      return;
    }

    if (base === "ONLINE_RANK_V2") {
      const watched = parseLooseCount(command?.data?.count ?? command?.data?.online_count);
      if (watched > this.peakRealtimeViewers) this.peakRealtimeViewers = watched;
      return;
    }

    if (base === "ROOM_REAL_TIME_MESSAGE_UPDATE") {
      const data = command?.data;
      const realtime = parseLooseCount(
        data?.online ?? data?.online_count ?? data?.viewer ?? data?.realtime ?? data?.count,
      );
      if (realtime > this.peakRealtimeViewers) this.peakRealtimeViewers = realtime;

      const watched = parseLooseCount(data?.watched_show?.num ?? data?.watched);
      if (watched > this.peakPopularity) this.peakPopularity = watched;
      return;
    }

    if (base === "SUPER_CHAT_MESSAGE") {
      this.applySuperChat(command?.data);
      return;
    }

    if (base === "SEND_GIFT") {
      this.applyGift(command?.data);
      return;
    }

    if (base === "GUARD_BUY") {
      this.applyGuard(command?.data);
      return;
    }

    if (base === "PREPARING") {
      void this.stop("preparing");
    }
  }

  applySuperChat(data) {
    if (!data || typeof data !== "object") return;

    const eventId = clampText(data.id_str ?? data.id, 80);
    if (eventId) {
      if (this.scSeen.has(eventId)) return;
      this.scSeen.add(eventId);
    }

    const price = Number(data.price);
    if (Number.isFinite(price) && price > 0) {
      this.superChatRevenueCny += price;
    }
  }

  applyGift(data) {
    if (!data || typeof data !== "object") return;

    const eventId = clampText(data.id ?? data.eventId ?? data.tid, 120);
    if (eventId) {
      if (this.giftSeen.has(eventId)) return;
      this.giftSeen.add(eventId);
    }

    if (String(data.coin_type) !== "gold") return;

    const totalCoin = Number(data.total_coin);
    const price = Number(data.price);
    const num = Number(data.num);

    let cny = 0;
    if (Number.isFinite(totalCoin) && totalCoin > 0) {
      cny = totalCoin / 1000;
    } else if (Number.isFinite(price) && price > 0) {
      const count = Number.isFinite(num) && num > 0 ? num : 1;
      cny = (price * count) / 1000;
    }

    if (cny > 0) this.giftRevenueCny += cny;
  }

  applyGuard(data) {
    if (!data || typeof data !== "object") return;

    const eventId = clampText(data.id ?? data.eventId, 120);
    if (eventId) {
      if (this.guardSeen.has(eventId)) return;
      this.guardSeen.add(eventId);
    }

    const num = Number(data.num);
    const count = Number.isFinite(num) && num > 0 ? num : 1;
    const totalPrice = Number(data.total_price);
    const unitPrice = Number(data.price);

    let cny = 0;
    if (Number.isFinite(totalPrice) && totalPrice > 0) {
      cny = totalPrice > 1000 ? totalPrice / 1000 : totalPrice;
    } else if (Number.isFinite(unitPrice) && unitPrice > 0) {
      const gross = unitPrice * count;
      cny = gross > 1000 ? gross / 1000 : gross;
    }

    if (cny > 0) this.giftRevenueCny += cny;
  }
}

async function fetchLiveStatusByMid(mid) {
  const json = await fetchJson(`${ROOM_INFO_OLD_API}${mid}`);
  if (!json || json.code !== 0 || !json.data) return null;
  return {
    liveStatus: toNonNegativeInt(json.data.liveStatus, 0),
    roomId: toNonNegativeInt(json.data.roomid, 0),
    title: clampText(json.data.title, 140),
  };
}

async function fetchRoomDetail(roomId) {
  const json = await fetchJson(`${ROOM_INFO_API}${roomId}`);
  if (!json || json.code !== 0 || !json.data) return null;
  return {
    liveStatus: toNonNegativeInt(json.data.live_status, 0),
    title: clampText(json.data.title, 140),
    liveTime: clampText(json.data.live_time, 32),
    online: toNonNegativeInt(json.data.online, 0),
  };
}

async function main() {
  await loadDotEnvIfPresent();

  const connectionString = pickConnectionString();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = new Pool({
    connectionString,
    ssl: isLocalConnection(connectionString) ? undefined : { rejectUnauthorized: false },
  });

  await ensureSiteContentTable(pool);

  const store = new LiveSessionStore(pool);
  await store.load();

  const collectors = new Map();
  let polling = false;
  let stopping = false;
  let pollTimer = null;

  const reconcileOne = async (member) => {
    const status = await fetchLiveStatusByMid(member.mid);
    const collector = collectors.get(member.key);

    if (!status) return;

    if (status.liveStatus === 1 && status.roomId > 0) {
      if (collector && collector.roomId !== status.roomId) {
        await collector.stop("room-changed");
        collectors.delete(member.key);
      }

      const current = collectors.get(member.key);
      if (current) {
        if (!current.running) {
          collectors.delete(member.key);
        } else {
          current.updateFromStatus(status);
          return;
        }
      }

      const detail = await fetchRoomDetail(status.roomId);
      const startedAtHint = parseBiliLiveTimeToIso(detail?.liveTime) || nowIso();
      const collectorNew = new LiveSessionCollector({
        member,
        roomId: status.roomId,
        title: detail?.title || status.title || `${member.key} live`,
        startedAtHint,
        store,
      });

      if (detail?.online) {
        collectorNew.peakPopularity = Math.max(collectorNew.peakPopularity, detail.online);
      }

      collectors.set(member.key, collectorNew);
      await collectorNew.start();
      return;
    }

    if (collector) {
      await collector.stop("live-offline");
      collectors.delete(member.key);
    }
  };

  const pollMembers = async () => {
    if (polling || stopping) return;
    polling = true;
    try {
      for (const member of MEMBERS) {
        await reconcileOne(member);
      }
      await store.flush();
    } finally {
      polling = false;
    }
  };

  const stopAll = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${nowIso()} [live] received ${signal}, stopping collectors...`);

    if (pollTimer) clearInterval(pollTimer);

    for (const collector of collectors.values()) {
      await collector.stop("shutdown");
    }
    collectors.clear();

    await store.flush(true);
    await pool.end();
  };

  process.on("SIGINT", () => {
    void stopAll("SIGINT").then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void stopAll("SIGTERM").then(() => process.exit(0));
  });

  await pollMembers();
  pollTimer = setInterval(() => {
    void pollMembers();
  }, POLL_INTERVAL_MS);

  console.log(`${nowIso()} [live] collector running; poll interval ${POLL_INTERVAL_MS}ms`);
}
try {
  await main();
} catch (err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (code === "28000") {
    const conn = safeConnInfo(pickConnectionString());
    console.error(`${nowIso()} [live] database login denied (code=28000).`);
    if (conn) {
      console.error(`${nowIso()} [live] using host=${conn.host} db=${conn.database} user=${conn.user}`);
    }
    console.error(
      `${nowIso()} [live] fix: replace DATABASE_URL with a currently valid credential from your DB provider.`,
    );
  } else if (err instanceof Error) {
    console.error(`${nowIso()} [live] ${err.message}`);
  }
  process.exit(1);
}

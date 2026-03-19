/* =========================
   CONFIG
   ========================= */
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Device-Id,X-Device-Token",
  "Cache-Control": "no-store",
};

const TEXT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Device-Id,X-Device-Token",
  "Cache-Control": "no-store",
};

const SETTINGS_KEY = "settings";
const LAST_SEEN_KEY = "lastSeen";
const MAILBOX_KEY = "mailbox";
const TRUSTED_USER_PREFIX = "trustedUser:v1:";
const SESSION_PREFIX = "session:v1:";
const SESSION_COOKIE_NAME = "__Host-guardian_session";
const DEVICE_PREFIX = "device:v1:";
const DEVICE_SETTINGS_PREFIX = "deviceSettings:v1:";
const DEVICE_LASTSEEN_PREFIX = "deviceLastSeen:v1:";
const DEVICE_MAILBOX_PREFIX = "deviceMailbox:v1:";

/* ===== FREE TIER THROTTLES ===== */
const HEARTBEAT_MIN_WRITE_MS = 5 * 60 * 1000;
const ONLINE_WINDOW_MS = 60 * 1000;
const LASTSEEN_CACHE_TTL_SECONDS = 2 * 60;

/* ===== SERVER-SIDE SESSION TTL ===== */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/* Dexcom Share endpoints */
const BASE_URLS = {
  us: "https://share2.dexcom.com/ShareWebServices/Services/",
  ous: "https://shareous1.dexcom.com/ShareWebServices/Services/",
  jp: "https://share.dexcom.jp/ShareWebServices/Services/",
};

const APPLICATION_IDS = {
  us: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  ous: "d89443d2-327c-4a6f-89e5-496bbb0317db",
  jp: "d8665ade-9673-4e27-9ff6-92db4ce13d13",
};

/* =========================
   CACHE KEYS
   ========================= */
const CACHE_LASTSEEN = new Request("https://cache.guardian/local/lastSeen");
const CACHE_TRUSTED_USERS = new Request("https://cache.guardian/local/trustedUsers");

/* =========================
   CACHE HELPERS
   ========================= */
async function cachePutJson(reqKey, obj, ttlSeconds = 12 * 60) {
  const res = new Response(JSON.stringify(obj), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttlSeconds}`,
    },
  });
  await caches.default.put(reqKey, res);
}

async function cacheGetJson(reqKey) {
  const res = await caches.default.match(reqKey);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* =========================
   RESP HELPERS
   ========================= */
function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: { ...TEXT_HEADERS, ...extraHeaders },
  });
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function readJson(request) {
  try {
    const ct = request.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("application/json")) {
      return { ok: false, error: "Expected application/json" };
    }
    const data = await request.json();
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

/* =========================
   KV quota-safe wrappers
   ========================= */
function isKvLimitError(e) {
  return String(e || "").toLowerCase().includes("kv put() limit exceeded");
}

async function kvPutSafe(env, key, value, options = undefined) {
  try {
    await env.ESP32_KV.put(key, value, options);
    return { ok: true, kvLimited: false };
  } catch (e) {
    if (isKvLimitError(e)) {
      return { ok: false, kvLimited: true, error: String(e) };
    }
    throw e;
  }
}

/* =========================
   SESSION HELPERS
   =========================

   Security note:
   We no longer send Dexcom credentials back to the browser inside a token.
   Instead, the Worker stores the sensitive Dexcom session server-side in KV and
   gives the browser only a random opaque session id inside an HttpOnly cookie.
   That means JavaScript in the page cannot read the Dexcom password.
*/
function b64urlEncodeBytes(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    bin += String.fromCharCode(arr[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomOpaqueId(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return b64urlEncodeBytes(bytes);
}

function buildSessionKey(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

function makeSessionCookie(sessionId, maxAgeSeconds = SESSION_TTL_SECONDS) {
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function clearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  const parts = raw.split(";");
  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    if (eqIndex < 0) continue;
    const key = part.slice(0, eqIndex).trim();
    if (key !== name) continue;
    return part.slice(eqIndex + 1).trim();
  }
  return "";
}

function readBearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(h);
  return m ? m[1] : "";
}

async function saveServerSession(env, sessionData) {
  const sessionId = randomOpaqueId();
  const key = buildSessionKey(sessionId);
  const out = await kvPutSafe(
    env,
    key,
    JSON.stringify(sessionData),
    { expirationTtl: SESSION_TTL_SECONDS }
  );

  return {
    ok: !!out.ok,
    sessionId,
    save: out,
  };
}

async function loadServerSession(env, sessionId) {
  if (!sessionId) return null;
  const raw = await env.ESP32_KV.get(buildSessionKey(sessionId));
  const session = safeJsonParse(raw, null);
  return session && typeof session === "object" ? session : null;
}

async function deleteServerSession(env, sessionId) {
  if (!sessionId) return;
  await env.ESP32_KV.delete(buildSessionKey(sessionId));
}

async function requireSession(request, env) {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME) || readBearer(request);
  if (!sessionId) return null;
  return await loadServerSession(env, sessionId);
}

/* =========================
   DEVICE HELPERS
   =========================

   The long-term goal is one user -> one or more devices -> one private mailbox
   per device. The website proves ownership with the normal authenticated user
   session. The ESP32 proves ownership with a device token.
*/
async function sha256B64Url(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text || ""))
  );
  return b64urlEncodeBytes(new Uint8Array(digest));
}

function normalizeDeviceId(value, fallback = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;

  const cleaned = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);

  return cleaned || fallback;
}

async function buildDefaultDeviceId(session) {
  const ownerHash = await sha256B64Url(
    `${String(session?.region || "us").trim().toLowerCase()}:${String(session?.accountId || "").trim()}`
  );

  return `guard-${ownerHash.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
}

function readRequestedDeviceId(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("device_id");
  const fromHeader = request.headers.get("x-device-id");
  return normalizeDeviceId(fromQuery || fromHeader || "");
}

function readDeviceToken(request) {
  return String(request.headers.get("x-device-token") || "").trim();
}

function buildDeviceKey(deviceId) {
  return `${DEVICE_PREFIX}${deviceId}`;
}

function buildSettingsKey(deviceId) {
  return `${DEVICE_SETTINGS_PREFIX}${deviceId}`;
}

function buildLastSeenKey(deviceId) {
  return `${DEVICE_LASTSEEN_PREFIX}${deviceId}`;
}

function buildMailboxKey(deviceId) {
  return `${DEVICE_MAILBOX_PREFIX}${deviceId}`;
}

function cacheLastSeenKey(deviceId) {
  return new Request(
    `https://cache.guardian/local/lastSeen/${encodeURIComponent(deviceId)}`
  );
}

async function loadDeviceRecord(env, deviceId) {
  if (!deviceId) return null;
  const raw = await env.ESP32_KV.get(buildDeviceKey(deviceId));
  const record = safeJsonParse(raw, null);
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

async function saveDeviceRecord(env, deviceId, record) {
  const out = await kvPutSafe(env, buildDeviceKey(deviceId), JSON.stringify(record));
  return { record, save: out };
}

function sessionOwnsDevice(session, record) {
  if (!session || !record) return false;

  return (
    String(session.accountId || "").trim() === String(record.owner_account_id || "").trim() &&
    String(session.region || "us").trim().toLowerCase() ===
      String(record.owner_region || "us").trim().toLowerCase()
  );
}

async function ensureOwnedDevice(env, session) {
  const deviceId = await buildDefaultDeviceId(session);
  const existing = await loadDeviceRecord(env, deviceId);

  if (existing) {
    return {
      ok: true,
      deviceId,
      record: existing,
      created: false,
      deviceToken: null,
    };
  }

  const deviceToken = randomOpaqueId(24);
  const now = Date.now();
  const record = {
    device_id: deviceId,
    owner_account_id: String(session?.accountId || "").trim(),
    owner_region: String(session?.region || "us").trim().toLowerCase(),
    token_hash: await sha256B64Url(deviceToken),
    token_hint: deviceToken.slice(-4),
    created_at: now,
    updated_at: now,
  };

  const save = await saveDeviceRecord(env, deviceId, record);
  return {
    ok: !!save.save.ok,
    deviceId,
    record,
    created: !!save.save.ok,
    deviceToken,
    save: save.save,
  };
}

async function rotateOwnedDeviceToken(env, session) {
  const ensured = await ensureOwnedDevice(env, session);
  if (!ensured.ok) return ensured;

  const deviceToken = randomOpaqueId(24);
  const record = {
    ...ensured.record,
    token_hash: await sha256B64Url(deviceToken),
    token_hint: deviceToken.slice(-4),
    updated_at: Date.now(),
  };

  const save = await saveDeviceRecord(env, ensured.deviceId, record);
  return {
    ok: !!save.save.ok,
    deviceId: ensured.deviceId,
    record,
    deviceToken,
    save: save.save,
  };
}

async function requireOwnedDevice(request, env, options = {}) {
  const session = await requireSession(request, env);
  if (!session) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const requestedDeviceId = readRequestedDeviceId(request);
  if (requestedDeviceId) {
    const record = await loadDeviceRecord(env, requestedDeviceId);
    if (!record) {
      return { ok: false, status: 404, error: "Unknown device" };
    }

    if (!sessionOwnsDevice(session, record)) {
      return { ok: false, status: 403, error: "That device belongs to a different user" };
    }

    return {
      ok: true,
      auth: "session",
      session,
      deviceId: requestedDeviceId,
      device: record,
      created: false,
      deviceToken: null,
    };
  }

  if (options.createIfMissing === false) {
    const defaultDeviceId = await buildDefaultDeviceId(session);
    const record = await loadDeviceRecord(env, defaultDeviceId);
    if (!record) {
      return { ok: false, status: 404, error: "No device registered for this user yet" };
    }

    return {
      ok: true,
      auth: "session",
      session,
      deviceId: defaultDeviceId,
      device: record,
      created: false,
      deviceToken: null,
    };
  }

  const ensured = await ensureOwnedDevice(env, session);
  if (!ensured.ok) {
    return {
      ok: false,
      status: ensured.save?.kvLimited ? 429 : 500,
      error: "Could not prepare a device for this user",
      kv_limited: !!ensured.save?.kvLimited,
    };
  }

  return {
    ok: true,
    auth: "session",
    session,
    deviceId: ensured.deviceId,
    device: ensured.record,
    created: ensured.created,
    deviceToken: ensured.deviceToken,
  };
}

async function requireDeviceTokenAuth(request, env) {
  const deviceId = readRequestedDeviceId(request);
  if (!deviceId) {
    return { ok: false, status: 400, error: "Missing device_id" };
  }

  const record = await loadDeviceRecord(env, deviceId);
  if (!record) {
    return { ok: false, status: 404, error: "Unknown device" };
  }

  const token = readDeviceToken(request);
  if (!token) {
    return { ok: false, status: 401, error: "Missing device token" };
  }

  const tokenHash = await sha256B64Url(token);
  if (tokenHash !== record.token_hash) {
    return { ok: false, status: 401, error: "Invalid device token" };
  }

  return {
    ok: true,
    auth: "device",
    deviceId,
    device: record,
  };
}

async function resolveDeviceContext(request, env, options = {}) {
  if (options.allowSession !== false) {
    const owned = await requireOwnedDevice(request, env, {
      createIfMissing: options.createIfMissing,
    });

    if (owned.ok) {
      return owned;
    }

    // If the request named a device id and the signed-in user is not allowed to
    // use it, fail immediately instead of silently falling through to another auth
    // mode. This makes cross-user mistakes obvious.
    if (owned.status && owned.status !== 401 && readRequestedDeviceId(request)) {
      return owned;
    }
  }

  if (options.allowDeviceToken) {
    return await requireDeviceTokenAuth(request, env);
  }

  return { ok: false, status: 401, error: "Unauthorized" };
}

/* =========================
   Dexcom
   ========================= */
function dexcomHeaders() {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "GUARDIAN/1.0 (Cloudflare Worker)",
  };
}

async function dexcomPost(region, endpoint, data) {
  const base = BASE_URLS[region] || BASE_URLS.us;

  const r = await fetch(base + endpoint, {
    method: "POST",
    headers: dexcomHeaders(),
    body: JSON.stringify(data ?? {}),
  });

  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    const e = new Error(`Dexcom HTTP ${r.status} ${endpoint}: ${txt.slice(0, 800)}`);
    e.status = r.status;
    e.body = txt.slice(0, 800);
    throw e;
  }

  const t0 = (txt || "").trim();
  try {
    return JSON.parse(t0);
  } catch {
    const e = new Error(`Dexcom parse fail ${endpoint}: ${t0.slice(0, 200)}`);
    e.status = 500;
    e.body = t0.slice(0, 200);
    throw e;
  }
}

async function dexcomPlainPost(region, endpoint, query = {}) {
  const base = BASE_URLS[region] || BASE_URLS.us;
  const url = new URL(base + endpoint);

  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v ?? ""));
  }

  const r = await fetch(url.toString(), {
    method: "POST",
    headers: dexcomHeaders(),
    body: "{}",
  });

  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    const e = new Error(`Dexcom HTTP ${r.status} ${endpoint}: ${txt.slice(0, 800)}`);
    e.status = r.status;
    e.body = txt.slice(0, 800);
    throw e;
  }

  return txt.trim();
}

async function dexcomCheckRemoteMonitoring(region, sessionId) {
  const txt = await dexcomPlainPost(
    region,
    "Publisher/IsRemoteMonitoringSessionActive",
    { sessionId }
  );
  return txt.toLowerCase() === "true";
}

async function dexcomStartRemoteMonitoring(region, sessionId, serialNumber = "") {
  await dexcomPlainPost(
    region,
    "Publisher/StartRemoteMonitoringSession",
    { sessionId, serialNumber }
  );
  return true;
}

function toSeconds(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function parseDexcomDT(dtStr) {
  const s = String(dtStr || "");
  const m = /Date\((\d+)(?:[+-]\d{4})?\)/.exec(s);
  if (!m) return 0;
  return toSeconds(m[1]);
}

async function dexcomGetReadings(region, sessionId, minutes = 60, maxCount = 24) {
  const base = BASE_URLS[region] || BASE_URLS.us;

  const url =
    base +
    "Publisher/ReadPublisherLatestGlucoseValues" +
    `?sessionId=${encodeURIComponent(sessionId)}&minutes=${encodeURIComponent(minutes)}&maxCount=${encodeURIComponent(maxCount)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: dexcomHeaders(),
    body: "{}",
  });

  const txt = await r.text().catch(() => "");
  if (!r.ok) {
    const e = new Error(`Dexcom HTTP ${r.status} readings: ${txt.slice(0, 800)}`);
    e.status = r.status;
    e.body = txt.slice(0, 800);
    throw e;
  }

  const arr = safeJsonParse(txt, null);
  if (!Array.isArray(arr) || !arr.length) return [];

  const seen = new Set();
  const points = [];

  for (const row of arr) {
    const glucose = Number(row?.Value);
    const trend = row?.Trend ?? null;
    const ts = parseDexcomDT(row?.DT);

    if (!Number.isFinite(glucose)) continue;
    if (!ts) continue;
    if (seen.has(ts)) continue;

    seen.add(ts);
    points.push({ ts, glucose, trend });
  }

  points.sort((a, b) => a.ts - b.ts);
  return points;
}

/* =========================
   Heartbeat write throttle
   ========================= */
async function heartbeatThrottled(env, deviceId) {
  const now = Date.now();
  const lastSeenKey = buildLastSeenKey(deviceId);
  const cacheKey = cacheLastSeenKey(deviceId);

  const lastSeenRaw = await env.ESP32_KV.get(lastSeenKey);
  const lastKv = lastSeenRaw ? Number(lastSeenRaw) : 0;

  if (lastKv > 0 && (now - lastKv) < HEARTBEAT_MIN_WRITE_MS) {
    // Skip the expensive KV write, but still record the current heartbeat time
    // in cache so /status reflects live connectivity instead of a stale KV timestamp.
    await cachePutJson(cacheKey, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
    return { ok: true, wrote: false, lastSeen: now, used: "cache" };
  }

  const out = await kvPutSafe(env, lastSeenKey, String(now));
  if (!out.ok && out.kvLimited) {
    await cachePutJson(cacheKey, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
    return { ok: true, wrote: false, lastSeen: now, used: "cache" };
  }

  await cachePutJson(cacheKey, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
  return { ok: true, wrote: true, lastSeen: now, used: "kv" };
}

/* =========================
   Settings (KV best effort)
   ========================= */
async function getSettings(env, deviceId) {
  const raw = await env.ESP32_KV.get(buildSettingsKey(deviceId));
  const s =
    safeJsonParse(raw, { glucose_low: 80, glucose_high: 180 }) ||
    { glucose_low: 80, glucose_high: 180 };

  return {
    low: Number(s.glucose_low ?? 80) || 80,
    high: Number(s.glucose_high ?? 180) || 180,
  };
}

async function setSettings(env, deviceId, low, high) {
  const cleanLow = Number(low);
  const cleanHigh = Number(high);

  const settings = {
    glucose_low: Number.isFinite(cleanLow) ? cleanLow : 80,
    glucose_high: Number.isFinite(cleanHigh) ? cleanHigh : 180,
  };

  const out = await kvPutSafe(env, buildSettingsKey(deviceId), JSON.stringify(settings));
  return { settings, save: out };
}

/*
  MAILBOX OVERVIEW

  Think of the mailbox as one shared JSON object that the website can write and
  the ESP32 can read. The goal is to avoid creating a brand new route every
  time you want to send one more value to the device.

  Example mailbox:
  {
    current_glucose: 142,
    predicted_far: 185,
    message: "Drink water",
    robot_mode: "alert"
  }

  Why this is useful:
  - Adding a new value usually means only adding a new key.
  - The website can send many values in one request.
  - The ESP32 only has to poll one endpoint: /mailbox
*/
async function readMailbox(env, deviceId) {
  const raw = await env.ESP32_KV.get(buildMailboxKey(deviceId));
  const mailbox = safeJsonParse(raw, {});
  const cleanMailbox =
    mailbox && typeof mailbox === "object" && !Array.isArray(mailbox) ? mailbox : {};

  // low/high now live in mailbox too. If they are missing there, fall back to
  // the older settings storage so existing thresholds keep showing up until the
  // website saves them into mailbox.
  const settings = await getSettings(env, deviceId);

  return {
    glucose_low: Number(cleanMailbox.glucose_low ?? settings.low ?? 80) || 80,
    glucose_high: Number(cleanMailbox.glucose_high ?? settings.high ?? 180) || 180,
    ...cleanMailbox,
  };
}

async function saveMailboxPatch(env, deviceId, patch) {
  // We merge the new keys into the existing mailbox instead of replacing
  // the whole object. That lets the website update one field at a time.
  // Example: posting { message: "Hello" } keeps current_glucose intact.
  const current = await readMailbox(env, deviceId);
  const mailbox = {
    ...current,
    ...patch,
    // updatedAt is handy for debugging and lets the ESP32 tell when the
    // mailbox was last changed.
    updatedAt: Date.now(),
  };

  const save = await kvPutSafe(env, buildMailboxKey(deviceId), JSON.stringify(mailbox));
  return { mailbox, save };
}

async function handleTrustedUsersCount(env) {
  const result = await getTrustedUsersCount(env);
  return jsonResponse({
    ok: true,
    count: result.count,
    cached: !!result.cached,
  });
}

/* =========================
   ROUTE HELPERS
   ========================= */
async function handleDexcomLogin(request, env) {
  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  const username = String(body.data?.username || "").trim();
  const password = String(body.data?.password || "").trim();
  const region = String(body.data?.region || "us").trim().toLowerCase();

  if (!username || !password) {
    return jsonResponse({ ok: false, error: "Missing username or password" }, 400);
  }

  if (!BASE_URLS[region]) {
    return jsonResponse({ ok: false, error: "Invalid region" }, 400);
  }

  try {
    const accountId = await dexcomPost(
      region,
      "General/AuthenticatePublisherAccount",
      {
        accountName: username,
        password,
        applicationId: APPLICATION_IDS[region],
      }
    );

    if (!accountId || typeof accountId !== "string") {
      return jsonResponse(
        { ok: false, error: "Dexcom login failed: no account id returned" },
        401
      );
    }

    const sessionId = await dexcomPost(
      region,
      "General/LoginPublisherAccountById",
      {
        accountId,
        password,
        applicationId: APPLICATION_IDS[region],
      }
    );

    if (!sessionId || typeof sessionId !== "string") {
      return jsonResponse(
        { ok: false, error: "Dexcom login failed: no session id returned" },
        401
      );
    }

    const ownerSession = {
      username,
      password,
      region,
      accountId,
      sessionId,
      createdAt: Date.now(),
    };

    const storedSession = await saveServerSession(
      env,
      ownerSession
    );

    if (!storedSession.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Could not save secure session",
          kv_limited: !!storedSession.save?.kvLimited,
        },
        storedSession.save?.kvLimited ? 429 : 500
      );
    }

    const deviceInfo = await ensureOwnedDevice(env, ownerSession);
    if (!deviceInfo.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Logged in, but could not prepare a device for this account",
          kv_limited: !!deviceInfo.save?.kvLimited,
        },
        deviceInfo.save?.kvLimited ? 429 : 500
      );
    }

    try {
      await rememberTrustedDexcomUser(env, region, accountId);
    } catch {}

    const trustedUsers = await getTrustedUsersCount(env, { bypassCache: true });

    return jsonResponse(
      {
        ok: true,
        region,
        trusted_users_count: trustedUsers.count,
        device_id: deviceInfo.deviceId,
        device_created: deviceInfo.created,
        device_token: deviceInfo.created ? deviceInfo.deviceToken : null,
        debug_saved_session_id: sessionId,
      },
      200,
      { "Set-Cookie": makeSessionCookie(storedSession.sessionId) }
    );
  } catch (e) {
    const msg = String(e?.message || "");
    const bodyText = String(e?.body || "");
    const fullError = bodyText || msg || "";

    return jsonResponse(
      {
        ok: false,
        error: fullError || "Dexcom login failed",
        dexcom_status: e?.status || null,
        debug_saved_session_id: null,
        debug_fresh_session_id: null,
      },
      e?.status && Number.isFinite(e.status) ? e.status : 500
    );
  }
}

async function buildTrustedUserKey(region, accountId) {
  const normalizedRegion = String(region || "us").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim().toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${normalizedRegion}:${normalizedAccountId}`)
  );
  const hashed = b64urlEncodeBytes(new Uint8Array(digest));
  return `${TRUSTED_USER_PREFIX}${hashed}`;
}

async function rememberTrustedDexcomUser(env, region, accountId) {
  const cleanAccountId = String(accountId || "").trim();
  if (!cleanAccountId) {
    return { ok: false, skipped: true };
  }

  const key = await buildTrustedUserKey(region, cleanAccountId);
  const existing = await env.ESP32_KV.get(key);
  if (existing !== null) {
    return { ok: true, created: false };
  }

  const save = await kvPutSafe(
    env,
    key,
    JSON.stringify({
      firstConnectedAt: Date.now(),
      region: String(region || "us").trim().toLowerCase(),
    })
  );

  try {
    await caches.default.delete(CACHE_TRUSTED_USERS);
  } catch {}

  return {
    ok: !!save.ok,
    created: !!save.ok,
    kvLimited: !!save.kvLimited,
    error: save?.error || null,
  };
}

async function getTrustedUsersCount(env, options = {}) {
  const bypassCache = !!options?.bypassCache;
  if (!bypassCache) {
    const cached = await cacheGetJson(CACHE_TRUSTED_USERS);
    const cachedCount = Number(cached?.count);
    if (Number.isFinite(cachedCount) && cachedCount >= 0) {
      return { ok: true, count: cachedCount, cached: true };
    }
  }

  let count = 0;
  let cursor = undefined;

  while (true) {
    const page = await env.ESP32_KV.list({
      prefix: TRUSTED_USER_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    count += Array.isArray(page?.keys) ? page.keys.length : 0;

    if (page?.list_complete || !page?.cursor) {
      break;
    }

    cursor = page.cursor;
  }

  await cachePutJson(CACHE_TRUSTED_USERS, { count }, 10 * 60);
  return { ok: true, count, cached: false };
}

async function handleDexcomRecent(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const minutes = Math.max(1, Math.min(1440, Number(url.searchParams.get("minutes") || 180)));
  const maxCount = Math.max(1, Math.min(288, Number(url.searchParams.get("maxCount") || 72)));

  let freshAccountId = null;
  let freshSessionId = null;

  try {
    freshAccountId = await dexcomPost(
      session.region,
      "General/AuthenticatePublisherAccount",
      {
        accountName: session.username,
        password: session.password,
        applicationId: APPLICATION_IDS[session.region],
      }
    );

    if (!freshAccountId || typeof freshAccountId !== "string") {
      return jsonResponse(
        {
          ok: false,
          error: "Dexcom re-auth failed: no account id returned",
          debug_saved_session_id: session.sessionId || null,
          debug_fresh_session_id: null,
        },
        401
      );
    }

    freshSessionId = await dexcomPost(
      session.region,
      "General/LoginPublisherAccountById",
      {
        accountId: freshAccountId,
        password: session.password,
        applicationId: APPLICATION_IDS[session.region],
      }
    );

    if (!freshSessionId || typeof freshSessionId !== "string") {
      return jsonResponse(
        {
          ok: false,
          error: "Dexcom re-auth failed: no session id returned",
          debug_saved_session_id: session.sessionId || null,
          debug_fresh_session_id: freshSessionId,
        },
        401
      );
    }

    const points = await dexcomGetReadings(
      session.region,
      freshSessionId,
      minutes,
      maxCount
    );

    const latest = points.length ? points[points.length - 1] : null;

    return jsonResponse({
      ok: true,
      points,
      latest,
      debug_saved_session_id: session.sessionId || null,
      debug_fresh_session_id: freshSessionId,
    });
  } catch (e) {
    const msg = String(e?.message || "");
    const bodyText = String(e?.body || "");
    const fullError = bodyText || msg || "";

    if (fullError.includes("SessionIdNotFound")) {
      return jsonResponse(
        {
          ok: true,
          points: [],
          latest: null,
          status: "no_active_sensor",
          message: "Dexcom authenticated, but no active CGM session was available.",
          debug_saved_session_id: session.sessionId || null,
          debug_fresh_session_id: freshSessionId,
        },
        200
      );
    }

    return jsonResponse(
      {
        ok: false,
        error: fullError || "Failed to fetch Dexcom data",
        dexcom_status: e?.status || null,
        debug_saved_session_id: session.sessionId || null,
        debug_fresh_session_id: freshSessionId,
      },
      e?.status && Number.isFinite(e.status) ? e.status : 500
    );
  }
}

async function handleDexcomLogout(request, env) {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME) || readBearer(request);
  if (sessionId) {
    try {
      await deleteServerSession(env, sessionId);
    } catch {}
  }

  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function handleStatus(request, env) {
  const context = await resolveDeviceContext(request, env, {
    allowSession: true,
    allowDeviceToken: true,
    createIfMissing: true,
  });

  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  const cached = await cacheGetJson(cacheLastSeenKey(context.deviceId));
  let lastSeen = Number(cached?.lastSeen || 0);

  if (!lastSeen) {
    const raw = await env.ESP32_KV.get(buildLastSeenKey(context.deviceId));
    lastSeen = raw ? Number(raw) : 0;
  }

  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    lastSeen: lastSeen || 0,
    online: !!lastSeen && (Date.now() - lastSeen) <= ONLINE_WINDOW_MS,
  });
}

async function handleGetSettings(request, env) {
  const context = await requireOwnedDevice(request, env, { createIfMissing: true });
  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  const s = await getSettings(env, context.deviceId);
  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    glucose_low: s.low,
    glucose_high: s.high,
  });
}

async function handleSetSettings(request, env) {
  const context = await requireOwnedDevice(request, env, { createIfMissing: true });
  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  const low = body.data?.glucose_low;
  const high = body.data?.glucose_high;
  const result = await setSettings(env, context.deviceId, low, high);

  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    settings: result.settings,
    kv_limited: !!result.save?.kvLimited,
  });
}

async function handleSessionStatus(request, env) {
  const context = await requireOwnedDevice(request, env, { createIfMissing: true });
  if (!context.ok) {
    return jsonResponse({ ok: true, logged_in: false });
  }

  const trustedUsers = await getTrustedUsersCount(env);

  return jsonResponse({
    ok: true,
    logged_in: true,
    region: context.session.region || "us",
    device_id: context.deviceId,
    device_created: context.created,
    trusted_users_count: trustedUsers.count,
  });
}

async function handleDeviceInfo(request, env) {
  const context = await requireOwnedDevice(request, env, { createIfMissing: true });
  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    token_hint: context.device?.token_hint || null,
    created_at: context.device?.created_at || null,
    updated_at: context.device?.updated_at || null,
  });
}

async function handleRotateDeviceToken(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const rotated = await rotateOwnedDeviceToken(env, session);
  if (!rotated.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Could not rotate device token",
        kv_limited: !!rotated.save?.kvLimited,
      },
      rotated.save?.kvLimited ? 429 : 500
    );
  }

  return jsonResponse({
    ok: true,
    device_id: rotated.deviceId,
    device_token: rotated.deviceToken,
    token_hint: rotated.record?.token_hint || null,
  });
}

async function handleMailboxGet(request, env) {
  // GET /mailbox is intentionally simple:
  // it returns the full mailbox for one authenticated device instead of one
  // global mailbox shared by every robot.
  const context = await resolveDeviceContext(request, env, {
    allowSession: true,
    allowDeviceToken: true,
    createIfMissing: true,
  });

  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  const mailbox = await readMailbox(env, context.deviceId);
  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    mailbox,
  });
}

async function handleMailboxPost(request, env) {
  // POST /mailbox is protected with the normal authenticated website session.
  // This prevents random visitors from changing what the ESP32 receives.
  const context = await requireOwnedDevice(request, env, { createIfMissing: true });
  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return jsonResponse({ ok: false, error: "Expected a JSON object body" }, 400);
  }

  // body.data is treated as a "patch", not a full replacement.
  // If the current mailbox is { current_glucose: 140, message: "Hi" }
  // and the website posts { predicted_far: 180 },
  // the saved mailbox becomes:
  // { current_glucose: 140, message: "Hi", predicted_far: 180, updatedAt: ... }
  const result = await saveMailboxPatch(env, context.deviceId, body.data);
  if (!result.save.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Mailbox save failed",
        kv_limited: !!result.save.kvLimited,
      },
      result.save.kvLimited ? 429 : 500
    );
  }

  return jsonResponse({
    ok: true,
    device_id: context.deviceId,
    mailbox: result.mailbox,
    kv_limited: !!result.save?.kvLimited,
  });
}

/* =========================
   Routes
   ========================= */
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (!env?.ESP32_KV) {
        return jsonResponse({ ok: false, error: "KV binding missing: ESP32_KV" }, 500);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: JSON_HEADERS });
      }

      if (url.pathname === "/heartbeat" && request.method === "GET") {
        const context = await requireDeviceTokenAuth(request, env);
        if (!context.ok) {
          return jsonResponse({ ok: false, error: context.error }, context.status || 401);
        }

        const out = await heartbeatThrottled(env, context.deviceId);
        return jsonResponse({ ...out, device_id: context.deviceId });
      }

      if (url.pathname === "/status" && request.method === "GET") {
        return await handleStatus(request, env);
      }

      if (url.pathname === "/session" && request.method === "GET") {
        return await handleSessionStatus(request, env);
      }

      if (url.pathname === "/device" && request.method === "GET") {
        return await handleDeviceInfo(request, env);
      }

      if (url.pathname === "/device/rotate-token" && request.method === "POST") {
        return await handleRotateDeviceToken(request, env);
      }

      if (url.pathname === "/get-settings" && request.method === "GET") {
        return await handleGetSettings(request, env);
      }

      if (url.pathname === "/set-settings" && request.method === "POST") {
        return await handleSetSettings(request, env);
      }

      if ((url.pathname === "/mailbox" || url.pathname === "/device-state") && request.method === "GET") {
        // "/device-state" is kept as a legacy alias so older code keeps working,
        // but "/mailbox" is the clearer name going forward.
        return await handleMailboxGet(request, env);
      }

      if ((url.pathname === "/mailbox" || url.pathname === "/device-state") && request.method === "POST") {
        return await handleMailboxPost(request, env);
      }

      if (url.pathname === "/trusted-users-count" && request.method === "GET") {
        return await handleTrustedUsersCount(env);
      }

      if (url.pathname === "/dexcom-login" && request.method === "POST") {
        return await handleDexcomLogin(request, env);
      }

      if (url.pathname === "/dexcom-recent" && request.method === "GET") {
        return await handleDexcomRecent(request, env);
      }

      if (url.pathname === "/dexcom-logout" && request.method === "POST") {
        return await handleDexcomLogout(request, env);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return textResponse("Not found", 404);
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: String(err?.stack || err || "Unknown server error"),
        },
        500
      );
    }
  },
};

/* =========================
   CONFIG
   ========================= */
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Cache-Control": "no-store",
};

const TEXT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Cache-Control": "no-store",
};

const SETTINGS_KEY = "settings";
const LAST_SEEN_KEY = "lastSeen";
const MAILBOX_KEY = "mailbox";
const TRUSTED_USER_PREFIX = "trustedUser:v1:";

/* ===== FREE TIER THROTTLES ===== */
const HEARTBEAT_MIN_WRITE_MS = 5 * 60 * 1000;
const ONLINE_WINDOW_MS = 60 * 1000;
const LASTSEEN_CACHE_TTL_SECONDS = 2 * 60;

/* ===== SIGNED SESSION TOKEN TTL ===== */
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
   SIGNED SESSION TOKENS
   ========================= */
function b64urlEncodeBytes(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    bin += String.fromCharCode(arr[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlEncodeString(str) {
  return b64urlEncodeBytes(new TextEncoder().encode(str));
}

function b64urlDecodeToString(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  return atob(padded);
}

async function hmacSha256(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return b64urlEncodeBytes(new Uint8Array(sig));
}

async function createSessionToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };

  const encodedHeader = b64urlEncodeString(JSON.stringify(header));
  const encodedPayload = b64urlEncodeString(JSON.stringify(fullPayload));
  const signingInput = encodedHeader + "." + encodedPayload;
  const signature = await hmacSha256(signingInput, secret);

  return signingInput + "." + signature;
}

async function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = encodedHeader + "." + encodedPayload;
  const expectedSignature = await hmacSha256(signingInput, secret);

  if (signature !== expectedSignature) return null;

  try {
    const header = JSON.parse(b64urlDecodeToString(encodedHeader));
    const payload = JSON.parse(b64urlDecodeToString(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (header?.alg !== "HS256") return null;
    if (!payload?.exp || now >= payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

function readBearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(h);
  return m ? m[1] : "";
}

async function requireSession(request, env) {
  const token = readBearer(request);
  if (!token) return null;
  if (!env?.SESSION_SECRET) return null;
  return await verifySessionToken(token, env.SESSION_SECRET);
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
async function heartbeatThrottled(env) {
  const now = Date.now();

  const lastSeenRaw = await env.ESP32_KV.get(LAST_SEEN_KEY);
  const lastKv = lastSeenRaw ? Number(lastSeenRaw) : 0;

  if (lastKv > 0 && (now - lastKv) < HEARTBEAT_MIN_WRITE_MS) {
    // Skip the expensive KV write, but still record the current heartbeat time
    // in cache so /status reflects live connectivity instead of a stale KV timestamp.
    await cachePutJson(CACHE_LASTSEEN, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
    return { ok: true, wrote: false, lastSeen: now, used: "cache" };
  }

  const out = await kvPutSafe(env, LAST_SEEN_KEY, String(now));
  if (!out.ok && out.kvLimited) {
    await cachePutJson(CACHE_LASTSEEN, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
    return { ok: true, wrote: false, lastSeen: now, used: "cache" };
  }

  await cachePutJson(CACHE_LASTSEEN, { lastSeen: now }, LASTSEEN_CACHE_TTL_SECONDS);
  return { ok: true, wrote: true, lastSeen: now, used: "kv" };
}

/* =========================
   Settings (KV best effort)
   ========================= */
async function getSettings(env) {
  const raw = await env.ESP32_KV.get(SETTINGS_KEY);
  const s =
    safeJsonParse(raw, { glucose_low: 80, glucose_high: 180 }) ||
    { glucose_low: 80, glucose_high: 180 };

  return {
    low: Number(s.glucose_low ?? 80) || 80,
    high: Number(s.glucose_high ?? 180) || 180,
  };
}

async function setSettings(env, low, high) {
  const cleanLow = Number(low);
  const cleanHigh = Number(high);

  const settings = {
    glucose_low: Number.isFinite(cleanLow) ? cleanLow : 80,
    glucose_high: Number.isFinite(cleanHigh) ? cleanHigh : 180,
  };

  const out = await kvPutSafe(env, SETTINGS_KEY, JSON.stringify(settings));
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
async function readMailbox(env) {
  const raw = await env.ESP32_KV.get(MAILBOX_KEY);
  const mailbox = safeJsonParse(raw, {});
  return mailbox && typeof mailbox === "object" && !Array.isArray(mailbox) ? mailbox : {};
}

async function saveMailboxPatch(env, patch) {
  // We merge the new keys into the existing mailbox instead of replacing
  // the whole object. That lets the website update one field at a time.
  // Example: posting { message: "Hello" } keeps current_glucose intact.
  const current = await readMailbox(env);
  const mailbox = {
    ...current,
    ...patch,
    // updatedAt is handy for debugging and lets the ESP32 tell when the
    // mailbox was last changed.
    updatedAt: Date.now(),
  };

  const save = await kvPutSafe(env, MAILBOX_KEY, JSON.stringify(mailbox));
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
  if (!env?.SESSION_SECRET) {
    return jsonResponse({ ok: false, error: "Server missing SESSION_SECRET" }, 500);
  }

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

    const token = await createSessionToken(
      {
        username,
        password,
        region,
        accountId,
        sessionId,
        createdAt: Date.now(),
      },
      env.SESSION_SECRET
    );

    try {
      await rememberTrustedDexcomUser(env, region, accountId);
    } catch {}

    const trustedUsers = await getTrustedUsersCount(env, { bypassCache: true });

    return jsonResponse({
      ok: true,
      token,
      region,
      trusted_users_count: trustedUsers.count,
      debug_saved_session_id: sessionId,
    });
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

async function handleDexcomLogout() {
  return jsonResponse({ ok: true });
}

async function handleStatus(env) {
  const cached = await cacheGetJson(CACHE_LASTSEEN);
  let lastSeen = Number(cached?.lastSeen || 0);

  if (!lastSeen) {
    const raw = await env.ESP32_KV.get(LAST_SEEN_KEY);
    lastSeen = raw ? Number(raw) : 0;
  }

  return jsonResponse({
    ok: true,
    lastSeen: lastSeen || 0,
    online: !!lastSeen && (Date.now() - lastSeen) <= ONLINE_WINDOW_MS,
  });
}

async function handleGetSettings(env) {
  const s = await getSettings(env);
  return jsonResponse({
    ok: true,
    glucose_low: s.low,
    glucose_high: s.high,
  });
}

async function handleSetSettings(request, env) {
  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  const low = body.data?.glucose_low;
  const high = body.data?.glucose_high;
  const result = await setSettings(env, low, high);

  return jsonResponse({
    ok: true,
    settings: result.settings,
    kv_limited: !!result.save?.kvLimited,
  });
}

async function handleMailboxGet(env) {
  // GET /mailbox is intentionally simple:
  // it just returns the full shared object so the ESP32 can read any keys it
  // cares about without needing separate endpoints.
  const mailbox = await readMailbox(env);
  return jsonResponse({
    ok: true,
    mailbox,
  });
}

async function handleMailboxPost(request, env) {
  // POST /mailbox is protected with the normal signed session token.
  // This prevents random visitors from changing what the ESP32 receives.
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
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
  const result = await saveMailboxPatch(env, body.data);
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

      if (!env?.SESSION_SECRET) {
        return jsonResponse({ ok: false, error: "Secret missing: SESSION_SECRET" }, 500);
      }

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: JSON_HEADERS });
      }

      if (url.pathname === "/heartbeat" && request.method === "GET") {
        const out = await heartbeatThrottled(env);
        return jsonResponse(out);
      }

      if (url.pathname === "/status" && request.method === "GET") {
        return await handleStatus(env);
      }

      if (url.pathname === "/get-settings" && request.method === "GET") {
        return await handleGetSettings(env);
      }

      if (url.pathname === "/set-settings" && request.method === "POST") {
        return await handleSetSettings(request, env);
      }

      if ((url.pathname === "/mailbox" || url.pathname === "/device-state") && request.method === "GET") {
        // "/device-state" is kept as a legacy alias so older code keeps working,
        // but "/mailbox" is the clearer name going forward.
        return await handleMailboxGet(env);
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
        return await handleDexcomLogout();
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

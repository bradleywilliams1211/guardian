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
const DEVICE_BOOTSTRAP_PREFIX = "deviceBootstrap:v1:";
const DEVICE_CLAIM_PREFIX = "deviceClaim:v1:";
const OWNER_DEVICE_PREFIX = "ownerDevice:v1:";
const OWNER_DEXCOM_PREFIX = "ownerDexcom:v1:";
const CONTROL_COMMAND_TTL_MS = 5 * 60 * 1000;

/* ===== FREE TIER THROTTLES ===== */
// Match the persisted heartbeat cadence to the device's 15s heartbeat interval
// so /status can mark an unplugged robot offline within about half a minute
// without relying on stale cached timestamps.
const HEARTBEAT_MIN_WRITE_MS = 15 * 1000;
const ONLINE_WINDOW_MS = 30 * 1000;
const LASTSEEN_CACHE_TTL_SECONDS = 2 * 60;

/* ===== SERVER-SIDE SESSION TTL ===== */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CLAIM_CODE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

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

const DEXCOM_DEFAULT_MINUTES = 180;
const DEXCOM_DEFAULT_MAX_COUNT = 72;
const DEXCOM_DEVICE_SYNC_MIN_MS = 15 * 1000;

/* =========================
   CACHE KEYS
   ========================= */
const CACHE_LASTSEEN = new Request("https://cache.guardian/local/lastSeen");
const CACHE_TRUSTED_USERS = new Request("https://cache.guardian/local/trustedUsers");
const OWNER_DEXCOM_CACHE_TTL_SECONDS = 60;

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

function normalizeHardwareId(value) {
  return normalizeDeviceId(value, "");
}

function normalizeClaimCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function randomClaimCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
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

function buildBootstrapKey(hardwareId) {
  return `${DEVICE_BOOTSTRAP_PREFIX}${hardwareId}`;
}

function buildClaimKey(claimCode) {
  return `${DEVICE_CLAIM_PREFIX}${claimCode}`;
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

async function buildOwnerDeviceKey(region, accountId) {
  const normalizedRegion = String(region || "us").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim().toLowerCase();
  const digest = await sha256B64Url(`${normalizedRegion}:${normalizedAccountId}`);
  return `${OWNER_DEVICE_PREFIX}${digest}`;
}

async function buildOwnerDexcomKey(region, accountId) {
  const normalizedRegion = String(region || "us").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim().toLowerCase();
  const digest = await sha256B64Url(`${normalizedRegion}:${normalizedAccountId}`);
  return `${OWNER_DEXCOM_PREFIX}${digest}`;
}

function cacheLastSeenKey(deviceId) {
  return new Request(
    `https://cache.guardian/local/lastSeen/${encodeURIComponent(deviceId)}`
  );
}

async function cacheOwnerDexcomPullKey(region, accountId) {
  const key = await buildOwnerDexcomKey(region, accountId);
  return new Request(
    `https://cache.guardian/local/ownerDexcomPull/${encodeURIComponent(key)}`
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

async function loadBootstrapRecord(env, hardwareId) {
  if (!hardwareId) return null;
  const raw = await env.ESP32_KV.get(buildBootstrapKey(hardwareId));
  const record = safeJsonParse(raw, null);
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

async function saveBootstrapRecord(env, hardwareId, record) {
  const out = await kvPutSafe(env, buildBootstrapKey(hardwareId), JSON.stringify(record));
  return { record, save: out };
}

async function saveClaimLookup(env, claimCode, hardwareId) {
  return await kvPutSafe(
    env,
    buildClaimKey(claimCode),
    JSON.stringify({ hardware_id: hardwareId, updated_at: Date.now() }),
    { expirationTtl: CLAIM_CODE_TTL_SECONDS }
  );
}

async function loadClaimLookup(env, claimCode) {
  const raw = await env.ESP32_KV.get(buildClaimKey(claimCode));
  const record = safeJsonParse(raw, null);
  return record && typeof record === "object" ? record : null;
}

async function deleteClaimLookup(env, claimCode) {
  if (!claimCode) return;
  await env.ESP32_KV.delete(buildClaimKey(claimCode));
}

async function setOwnerDeviceMapping(env, region, accountId, deviceId) {
  const key = await buildOwnerDeviceKey(region, accountId);
  return await kvPutSafe(env, key, deviceId);
}

async function deleteOwnerDeviceMapping(env, region, accountId) {
  const key = await buildOwnerDeviceKey(region, accountId);
  await env.ESP32_KV.delete(key);
}

async function getOwnerDeviceId(env, region, accountId) {
  const key = await buildOwnerDeviceKey(region, accountId);
  const value = await env.ESP32_KV.get(key);
  return String(value || "").trim();
}

async function loadOwnerDexcomRecord(env, region, accountId) {
  if (!String(accountId || "").trim()) return null;
  const raw = await env.ESP32_KV.get(await buildOwnerDexcomKey(region, accountId));
  const record = safeJsonParse(raw, null);
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

async function saveOwnerDexcomRecord(env, record) {
  const key = await buildOwnerDexcomKey(record?.region, record?.accountId);
  const out = await kvPutSafe(env, key, JSON.stringify(record));
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

async function findOwnedDeviceId(env, session) {
  const mapped = await getOwnerDeviceId(env, session?.region, session?.accountId);
  if (mapped) {
    return mapped;
  }

  // Backward compatibility:
  // older local/dev flows derived a deterministic device id from the Dexcom
  // account before we added claim-code onboarding. If that older device record
  // exists and still belongs to this user, adopt it as the user's current
  // claimed device.
  const legacyDeviceId = await buildDefaultDeviceId(session);
  const legacyRecord = await loadDeviceRecord(env, legacyDeviceId);
  if (!legacyRecord || !sessionOwnsDevice(session, legacyRecord)) {
    return "";
  }

  await setOwnerDeviceMapping(env, session.region, session.accountId, legacyDeviceId);
  return legacyDeviceId;
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

async function createPendingBootstrap(env, hardwareId, bootstrapSecretHash) {
  let claimCode = "";
  let claimSave = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    claimCode = randomClaimCode(8);
    const existingClaim = await loadClaimLookup(env, claimCode);
    if (existingClaim) {
      continue;
    }

    claimSave = await saveClaimLookup(env, claimCode, hardwareId);
    if (claimSave.ok) {
      break;
    }
  }

  if (!claimCode || !claimSave?.ok) {
    return {
      ok: false,
      error: "Could not reserve a claim code",
      save: claimSave,
    };
  }

  const record = {
    hardware_id: hardwareId,
    bootstrap_secret_hash: bootstrapSecretHash,
    claim_code: claimCode,
    state: "pending",
    claim_expires_at: Date.now() + (CLAIM_CODE_TTL_SECONDS * 1000),
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  const save = await saveBootstrapRecord(env, hardwareId, record);
  return {
    ok: !!save.save.ok,
    record,
    save: save.save,
  };
}

async function handleDeviceBootstrap(request, env) {
  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  const hardwareId = normalizeHardwareId(body.data?.hardware_id);
  const bootstrapSecret = String(body.data?.bootstrap_secret || "").trim();

  if (!hardwareId || !bootstrapSecret) {
    return jsonResponse(
      { ok: false, error: "Missing hardware_id or bootstrap_secret" },
      400
    );
  }

  const bootstrapSecretHash = await sha256B64Url(bootstrapSecret);
  let record = await loadBootstrapRecord(env, hardwareId);

  if (!record) {
    const created = await createPendingBootstrap(env, hardwareId, bootstrapSecretHash);
    if (!created.ok) {
      return jsonResponse(
        {
          ok: false,
          error: created.error || "Could not create device bootstrap record",
          kv_limited: !!created.save?.kvLimited,
        },
        created.save?.kvLimited ? 429 : 500
      );
    }

    record = created.record;
  }

  if (record.bootstrap_secret_hash !== bootstrapSecretHash) {
    return jsonResponse({ ok: false, error: "Bootstrap secret mismatch" }, 401);
  }

  if (record.state === "claimed" && record.device_id) {
    const deviceRecord = await loadDeviceRecord(env, record.device_id);
    if (!deviceRecord) {
      return jsonResponse({ ok: false, error: "Claimed device record was missing" }, 500);
    }

    const deviceToken = randomOpaqueId(24);
    const updatedRecord = {
      ...deviceRecord,
      token_hash: await sha256B64Url(deviceToken),
      token_hint: deviceToken.slice(-4),
      updated_at: Date.now(),
    };

    const save = await saveDeviceRecord(env, record.device_id, updatedRecord);
    if (!save.save.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "Could not refresh device token",
          kv_limited: !!save.save?.kvLimited,
        },
        save.save?.kvLimited ? 429 : 500
      );
    }

    return jsonResponse({
      ok: true,
      claimed: true,
      device_id: record.device_id,
      device_token: deviceToken,
      token_hint: updatedRecord.token_hint || null,
    });
  }

  if (record.state !== "pending") {
    return jsonResponse({ ok: false, error: "Unknown bootstrap state" }, 500);
  }

  if (Number(record.claim_expires_at || 0) && Date.now() > Number(record.claim_expires_at)) {
    await deleteClaimLookup(env, record.claim_code);
    const refreshed = await createPendingBootstrap(env, hardwareId, bootstrapSecretHash);
    if (!refreshed.ok) {
      return jsonResponse(
        {
          ok: false,
          error: refreshed.error || "Could not refresh claim code",
          kv_limited: !!refreshed.save?.kvLimited,
        },
        refreshed.save?.kvLimited ? 429 : 500
      );
    }
    record = refreshed.record;
  }

  return jsonResponse({
    ok: true,
    claimed: false,
    claim_code: record.claim_code,
    claim_expires_at: record.claim_expires_at,
    claim_url: new URL(request.url).origin,
  });
}

async function handleClaimDevice(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return jsonResponse({ ok: false, error: body.error }, 400);
  }

  const claimCode = normalizeClaimCode(body.data?.claim_code);
  if (!claimCode) {
    return jsonResponse({ ok: false, error: "Missing claim code" }, 400);
  }

  const currentOwnerDeviceId = await findOwnedDeviceId(env, session);
  let replacedPreviousDeviceId = "";

  const lookup = await loadClaimLookup(env, claimCode);
  if (!lookup?.hardware_id) {
    return jsonResponse({ ok: false, error: "Claim code not found or expired" }, 404);
  }

  const bootstrap = await loadBootstrapRecord(env, normalizeHardwareId(lookup.hardware_id));
  if (!bootstrap) {
    return jsonResponse({ ok: false, error: "Device onboarding record missing" }, 404);
  }

  if (bootstrap.state !== "pending") {
    return jsonResponse({ ok: false, error: "That device has already been claimed" }, 409);
  }

  if (bootstrap.claim_code !== claimCode) {
    return jsonResponse({ ok: false, error: "Claim code mismatch" }, 409);
  }

  const deviceId = `guard-${(await sha256B64Url(bootstrap.hardware_id)).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
  const deviceToken = randomOpaqueId(24);
  const now = Date.now();

  const deviceRecord = {
    device_id: deviceId,
    hardware_id: bootstrap.hardware_id,
    owner_account_id: String(session.accountId || "").trim(),
    owner_region: String(session.region || "us").trim().toLowerCase(),
    token_hash: await sha256B64Url(deviceToken),
    token_hint: deviceToken.slice(-4),
    created_at: now,
    updated_at: now,
  };

  const deviceSave = await saveDeviceRecord(env, deviceId, deviceRecord);
  if (!deviceSave.save.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Could not save claimed device",
        kv_limited: !!deviceSave.save?.kvLimited,
      },
      deviceSave.save?.kvLimited ? 429 : 500
    );
  }

  const ownerSave = await setOwnerDeviceMapping(env, session.region, session.accountId, deviceId);
  if (!ownerSave.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Could not link device to account",
        kv_limited: !!ownerSave.kvLimited,
      },
      ownerSave.kvLimited ? 429 : 500
    );
  }

  if (currentOwnerDeviceId && currentOwnerDeviceId !== deviceId) {
    const previousRecord = await loadDeviceRecord(env, currentOwnerDeviceId);
    if (previousRecord && sessionOwnsDevice(session, previousRecord)) {
      replacedPreviousDeviceId = currentOwnerDeviceId;
      const archivedPreviousRecord = {
        ...previousRecord,
        replaced_by_device_id: deviceId,
        replaced_at: now,
        updated_at: now,
      };
      await saveDeviceRecord(env, currentOwnerDeviceId, archivedPreviousRecord);
    }
  }

  const updatedBootstrap = {
    ...bootstrap,
    state: "claimed",
    device_id: deviceId,
    owner_account_id: String(session.accountId || "").trim(),
    owner_region: String(session.region || "us").trim().toLowerCase(),
    claimed_at: now,
    updated_at: now,
  };

  const bootstrapSave = await saveBootstrapRecord(env, bootstrap.hardware_id, updatedBootstrap);
  if (!bootstrapSave.save.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Device was claimed, but bootstrap state could not be updated",
        device_id: deviceId,
        kv_limited: !!bootstrapSave.save?.kvLimited,
      },
      bootstrapSave.save?.kvLimited ? 429 : 500
    );
  }

  await deleteClaimLookup(env, claimCode);

  return jsonResponse({
    ok: true,
    claimed: true,
    device_id: deviceId,
    replaced_previous_device_id: replacedPreviousDeviceId || null,
    message: replacedPreviousDeviceId
      ? "Device claimed. Your previous GUARD link was replaced with this robot."
      : "Device claimed. The robot will pick up its secure token automatically.",
  });
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

  const ownedDeviceId = await findOwnedDeviceId(env, session);
  if (ownedDeviceId) {
    const record = await loadDeviceRecord(env, ownedDeviceId);
    if (!record) {
      return { ok: false, status: 404, error: "That device is missing from storage" };
    }

    return {
      ok: true,
      auth: "session",
      session,
      deviceId: ownedDeviceId,
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

function buildGlucoseMailboxPatch(latest) {
  if (!latest) {
    return {
      current_glucose: null,
      current_glucose_ts: null,
      current_glucose_trend: "",
    };
  }

  return {
    current_glucose: Number(latest.glucose),
    current_glucose_ts: Number(latest.ts),
    current_glucose_trend: typeof latest.trend === "string" ? latest.trend : "",
  };
}

function sameMailboxGlucoseValue(current, next) {
  const currentValue = Number(current);
  const nextValue = Number(next);
  if (!Number.isFinite(currentValue) && !Number.isFinite(nextValue)) return true;
  return currentValue === nextValue;
}

function mailboxAlreadyMatchesGlucosePatch(mailbox, patch) {
  return (
    sameMailboxGlucoseValue(mailbox?.current_glucose, patch.current_glucose) &&
    sameMailboxGlucoseValue(mailbox?.current_glucose_ts, patch.current_glucose_ts) &&
    String(mailbox?.current_glucose_trend || "") === String(patch.current_glucose_trend || "")
  );
}

async function syncDeviceGlucoseMailbox(env, deviceId, latest) {
  if (!deviceId) {
    return { ok: true, skipped: true, wrote: false, unchanged: true };
  }

  const patch = buildGlucoseMailboxPatch(latest);
  const currentMailbox = await readMailbox(env, deviceId);

  if (mailboxAlreadyMatchesGlucosePatch(currentMailbox, patch)) {
    return { ok: true, skipped: false, wrote: false, unchanged: true };
  }

  const result = await saveMailboxPatch(env, deviceId, patch);
  return {
    ok: !!result.save?.ok,
    skipped: false,
    wrote: !!result.save?.ok,
    unchanged: false,
    mailbox: result.mailbox,
    save: result.save,
  };
}

async function markOwnerDexcomPull(env, region, accountId) {
  const cacheKey = await cacheOwnerDexcomPullKey(region, accountId);
  await cachePutJson(cacheKey, { last_pull_at: Date.now() }, OWNER_DEXCOM_CACHE_TTL_SECONDS);
  return { ok: true, cached: true };
}

async function shouldRefreshOwnerDexcomNow(env, region, accountId, minMs = DEXCOM_DEVICE_SYNC_MIN_MS) {
  const cacheKey = await cacheOwnerDexcomPullKey(region, accountId);
  const cached = await cacheGetJson(cacheKey);
  const lastPullAt = Number(cached?.last_pull_at || 0);
  if (lastPullAt > 0 && (Date.now() - lastPullAt) < minMs) {
    return { ok: true, allow: false, reason: "throttled", record: null };
  }

  const existing = await loadOwnerDexcomRecord(env, region, accountId);
  if (!existing) {
    return { ok: false, allow: false, reason: "missing_owner_record", record: null };
  }

  await cachePutJson(cacheKey, { last_pull_at: Date.now() }, OWNER_DEXCOM_CACHE_TTL_SECONDS);
  return {
    ok: true,
    allow: true,
    reason: "claimed",
    record: existing,
  };
}

function isActiveDexcomSessionRecord(session) {
  return !!(
    session &&
    typeof session === "object" &&
    String(session.username || "").trim() &&
    String(session.password || "").trim() &&
    String(session.accountId || "").trim() &&
    BASE_URLS[String(session.region || "us").trim().toLowerCase()]
  );
}

function buildDexcomSessionOwnerKey(session) {
  return `${String(session?.region || "us").trim().toLowerCase()}:${String(session?.accountId || "").trim().toLowerCase()}`;
}

function buildOwnerDexcomRecord(session, previous = null) {
  return {
    username: String(session?.username || "").trim(),
    password: String(session?.password || "").trim(),
    region: String(session?.region || "us").trim().toLowerCase(),
    accountId: String(session?.accountId || "").trim(),
    updated_at: Date.now(),
  };
}

async function rememberOwnerDexcomSession(env, session) {
  if (!isActiveDexcomSessionRecord(session)) {
    return { ok: false, skipped: true };
  }

  const existing = await loadOwnerDexcomRecord(env, session.region, session.accountId);
  const nextRecord = buildOwnerDexcomRecord(session, existing);
  const sameCredentials =
    existing &&
    existing.username === nextRecord.username &&
    existing.password === nextRecord.password &&
    existing.region === nextRecord.region &&
    existing.accountId === nextRecord.accountId;

  if (sameCredentials) {
    return { ok: true, skipped: true, record: existing };
  }

  return await saveOwnerDexcomRecord(env, nextRecord);
}

async function listActiveDexcomSessions(env) {
  const sessionsByOwner = new Map();
  let cursor = undefined;

  while (true) {
    const page = await env.ESP32_KV.list({
      prefix: SESSION_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    const raws = await Promise.all(
      (page?.keys || []).map((entry) => env.ESP32_KV.get(entry.name))
    );

    for (const raw of raws) {
      const session = safeJsonParse(raw, null);
      if (!isActiveDexcomSessionRecord(session)) continue;

      const ownerKey = buildDexcomSessionOwnerKey(session);
      const existing = sessionsByOwner.get(ownerKey);
      const createdAt = Number(session.createdAt || 0);
      const existingCreatedAt = Number(existing?.createdAt || 0);

      if (!existing || createdAt >= existingCreatedAt) {
        sessionsByOwner.set(ownerKey, session);
      }
    }

    if (page?.list_complete || !page?.cursor) {
      break;
    }

    cursor = page.cursor;
  }

  return Array.from(sessionsByOwner.values());
}

async function listSavedOwnerDexcomSessions(env) {
  const sessionsByOwner = new Map();
  let cursor = undefined;

  while (true) {
    const page = await env.ESP32_KV.list({
      prefix: OWNER_DEXCOM_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    const raws = await Promise.all(
      (page?.keys || []).map((entry) => env.ESP32_KV.get(entry.name))
    );

    for (const raw of raws) {
      const session = safeJsonParse(raw, null);
      if (!isActiveDexcomSessionRecord(session)) continue;
      sessionsByOwner.set(buildDexcomSessionOwnerKey(session), session);
    }

    if (page?.list_complete || !page?.cursor) {
      break;
    }

    cursor = page.cursor;
  }

  return Array.from(sessionsByOwner.values());
}

async function listDexcomSyncSubjects(env) {
  const merged = new Map();
  const saved = await listSavedOwnerDexcomSessions(env);
  for (const session of saved) {
    merged.set(buildDexcomSessionOwnerKey(session), session);
  }

  const active = await listActiveDexcomSessions(env);
  for (const session of active) {
    merged.set(buildDexcomSessionOwnerKey(session), session);
    await rememberOwnerDexcomSession(env, session);
  }

  return Array.from(merged.values());
}

async function refreshDexcomForSession(env, session, options = {}) {
  const minutes = Math.max(1, Math.min(1440, Number(options.minutes || DEXCOM_DEFAULT_MINUTES)));
  const maxCount = Math.max(1, Math.min(288, Number(options.maxCount || DEXCOM_DEFAULT_MAX_COUNT)));
  const syncMailbox = options.syncMailbox !== false;

  await rememberOwnerDexcomSession(env, session);

  let freshSessionId = null;
  let ownedDeviceId = "";

  async function ensureOwnedDeviceId() {
    if (ownedDeviceId) return ownedDeviceId;
    ownedDeviceId = await findOwnedDeviceId(env, session);
    return ownedDeviceId;
  }

  try {
    const freshAccountId = await dexcomPost(
      session.region,
      "General/AuthenticatePublisherAccount",
      {
        accountName: session.username,
        password: session.password,
        applicationId: APPLICATION_IDS[session.region],
      }
    );

    if (!freshAccountId || typeof freshAccountId !== "string") {
      await markOwnerDexcomPull(env, session.region, session.accountId);
      return {
        ok: false,
        error: "Dexcom re-auth failed: no account id returned",
        dexcom_status: 401,
        freshSessionId: null,
      };
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
      await markOwnerDexcomPull(env, session.region, session.accountId);
      return {
        ok: false,
        error: "Dexcom re-auth failed: no session id returned",
        dexcom_status: 401,
        freshSessionId,
      };
    }

    const points = await dexcomGetReadings(
      session.region,
      freshSessionId,
      minutes,
      maxCount
    );
    const latest = points.length ? points[points.length - 1] : null;

    let mailboxSync = null;
    if (syncMailbox) {
      mailboxSync = await syncDeviceGlucoseMailbox(env, await ensureOwnedDeviceId(), latest);
    }

    await markOwnerDexcomPull(env, session.region, session.accountId);
    return {
      ok: true,
      points,
      latest,
      status: "ok",
      freshSessionId,
      ownedDeviceId,
      mailboxSync,
    };
  } catch (e) {
    const msg = String(e?.message || "");
    const bodyText = String(e?.body || "");
    const fullError = bodyText || msg || "";

    if (fullError.includes("SessionIdNotFound")) {
      let mailboxSync = null;
      if (syncMailbox) {
        mailboxSync = await syncDeviceGlucoseMailbox(env, await ensureOwnedDeviceId(), null);
      }

      await markOwnerDexcomPull(env, session.region, session.accountId);
      return {
        ok: true,
        points: [],
        latest: null,
        status: "no_active_sensor",
        message: "Dexcom authenticated, but no active CGM session was available.",
        freshSessionId,
        ownedDeviceId,
        mailboxSync,
      };
    }

    await markOwnerDexcomPull(env, session.region, session.accountId);
    return {
      ok: false,
      error: fullError || "Failed to fetch Dexcom data",
      dexcom_status: e?.status || null,
      freshSessionId,
    };
  }
}

async function syncDexcomMailboxesForActiveSessions(env) {
  const sessions = await listDexcomSyncSubjects(env);
  const summary = {
    ok: true,
    scanned_sessions: sessions.length,
    synced_devices: 0,
    unchanged_devices: 0,
    no_active_sensor: 0,
    skipped_devices: 0,
    failed_sessions: 0,
  };

  for (const session of sessions) {
    const result = await refreshDexcomForSession(env, session, {
      minutes: DEXCOM_DEFAULT_MINUTES,
      maxCount: DEXCOM_DEFAULT_MAX_COUNT,
      syncMailbox: true,
    });

    if (!result.ok) {
      summary.failed_sessions += 1;
      console.warn(
        "Guardian scheduled Dexcom sync failed",
        JSON.stringify({
          region: session.region,
          accountId: session.accountId,
          error: result.error,
          dexcom_status: result.dexcom_status,
        })
      );
      continue;
    }

    if (result.status === "no_active_sensor") {
      summary.no_active_sensor += 1;
    }

    if (result.mailboxSync?.skipped) {
      summary.skipped_devices += 1;
    } else if (result.mailboxSync?.unchanged) {
      summary.unchanged_devices += 1;
    } else if (result.mailboxSync?.wrote) {
      summary.synced_devices += 1;
    }
  }

  console.log("Guardian scheduled Dexcom sync complete", JSON.stringify(summary));
  return summary;
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

  const now = Date.now();
  const sanitizeControlCommand = (commandKey, timestampKey) => {
    const commandValue = cleanMailbox[commandKey];
    const timestampValue = Number(cleanMailbox[timestampKey]);
    const hasCommand = typeof commandValue === "string" && commandValue.trim() !== "";
    const isFresh =
      Number.isFinite(timestampValue) &&
      timestampValue > 0 &&
      Math.abs(now - timestampValue) <= CONTROL_COMMAND_TTL_MS;

    if (hasCommand && !isFresh) {
      delete cleanMailbox[commandKey];
      delete cleanMailbox[timestampKey];
    }
  };

  sanitizeControlCommand("control_reenter_ble_setup", "control_reenter_ble_setup_at");
  sanitizeControlCommand("control_factory_reset", "control_factory_reset_at");

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
  const nextPatch =
    patch && typeof patch === "object" && !Array.isArray(patch) ? { ...patch } : {};

  if (
    typeof nextPatch.control_reenter_ble_setup === "string" &&
    nextPatch.control_reenter_ble_setup.trim() &&
    !Number.isFinite(Number(nextPatch.control_reenter_ble_setup_at))
  ) {
    nextPatch.control_reenter_ble_setup_at = Date.now();
  }

  if (
    typeof nextPatch.control_factory_reset === "string" &&
    nextPatch.control_factory_reset.trim() &&
    !Number.isFinite(Number(nextPatch.control_factory_reset_at))
  ) {
    nextPatch.control_factory_reset_at = Date.now();
  }

  const current = await readMailbox(env, deviceId);
  const mailbox = {
    ...current,
    ...nextPatch,
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
function friendlyDexcomLoginError(error) {
  const msg = String(error?.message || "");
  const bodyText = String(error?.body || "");
  const combined = `${msg}\n${bodyText}`.toLowerCase();

  if (
    combined.includes("authenticatepublisheraccount") ||
    combined.includes("loginpublisheraccountbyid") ||
    combined.includes("accountpasswordinvalid") ||
    combined.includes("account not found") ||
    combined.includes("no account id returned") ||
    combined.includes("no session id returned") ||
    combined.includes("invalid password") ||
    combined.includes("invalid account") ||
    combined.includes("authentication") ||
    combined.includes("<html") ||
    combined.includes("<!doctype") ||
    [400, 401, 403, 404, 500].includes(Number(error?.status))
  ) {
    return "No account found";
  }

  return "Dexcom login failed";
}

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
        { ok: false, error: "No account found" },
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
        { ok: false, error: "No account found" },
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

    await rememberOwnerDexcomSession(env, ownerSession);

    try {
      await rememberTrustedDexcomUser(env, region, accountId);
    } catch {}

    const trustedUsers = await getTrustedUsersCount(env, { bypassCache: true });
    const ownedDeviceId = await findOwnedDeviceId(env, ownerSession);

    return jsonResponse(
      {
        ok: true,
        region,
        trusted_users_count: trustedUsers.count,
        device_id: ownedDeviceId || "",
        device_claim_required: !ownedDeviceId,
        debug_saved_session_id: sessionId,
      },
      200,
      { "Set-Cookie": makeSessionCookie(storedSession.sessionId) }
    );
  } catch (e) {
    const friendlyError = friendlyDexcomLoginError(e);

    return jsonResponse(
      {
        ok: false,
        error: friendlyError,
        dexcom_status: e?.status || null,
        debug_saved_session_id: null,
        debug_fresh_session_id: null,
      },
      401
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
  const minutes = Math.max(1, Math.min(1440, Number(url.searchParams.get("minutes") || DEXCOM_DEFAULT_MINUTES)));
  const maxCount = Math.max(1, Math.min(288, Number(url.searchParams.get("maxCount") || DEXCOM_DEFAULT_MAX_COUNT)));

  const result = await refreshDexcomForSession(env, session, {
    minutes,
    maxCount,
    syncMailbox: true,
  });

  if (result.ok) {
    return jsonResponse({
      ok: true,
      points: result.points,
      latest: result.latest,
      status: result.status === "ok" ? undefined : result.status,
      message: result.message || undefined,
      debug_saved_session_id: session.sessionId || null,
      debug_fresh_session_id: result.freshSessionId || null,
    });
  }

  const responseStatus =
    result.dexcom_status && Number.isFinite(Number(result.dexcom_status))
      ? Number(result.dexcom_status)
      : 500;

  return jsonResponse(
    {
      ok: false,
      error: result.error || "Failed to fetch Dexcom data",
      dexcom_status: result.dexcom_status || null,
      debug_saved_session_id: session.sessionId || null,
      debug_fresh_session_id: result.freshSessionId || null,
    },
    responseStatus
  );
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
    createIfMissing: false,
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
  const context = await requireOwnedDevice(request, env, { createIfMissing: false });
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
  const context = await requireOwnedDevice(request, env, { createIfMissing: false });
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
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: true, logged_in: false });
  }

  const ownedDeviceId = await findOwnedDeviceId(env, session);
  const trustedUsers = await getTrustedUsersCount(env);

  return jsonResponse({
    ok: true,
    logged_in: true,
    region: session.region || "us",
    device_id: ownedDeviceId || "",
    device_claim_required: !ownedDeviceId,
    trusted_users_count: trustedUsers.count,
  });
}

async function handleDeviceInfo(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const deviceId = await findOwnedDeviceId(env, session);
  if (!deviceId) {
    return jsonResponse({
      ok: true,
      claimed: false,
      device_id: "",
      token_hint: null,
      created_at: null,
      updated_at: null,
    });
  }

  const record = await loadDeviceRecord(env, deviceId);
  if (!record) {
    return jsonResponse({ ok: false, error: "Claimed device record missing" }, 404);
  }

  return jsonResponse({
    ok: true,
    claimed: true,
    device_id: deviceId,
    token_hint: record.token_hint || null,
    created_at: record.created_at || null,
    updated_at: record.updated_at || null,
  });
}

async function handleBootstrapStatus(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const hardwareId = normalizeHardwareId(url.searchParams.get("hardware_id"));
  if (!hardwareId) {
    return jsonResponse({ ok: false, error: "Missing hardware_id" }, 400);
  }

  const bootstrap = await loadBootstrapRecord(env, hardwareId);
  if (!bootstrap) {
    return jsonResponse({
      ok: true,
      state: "waiting_for_device",
      hardware_id: hardwareId,
    });
  }

  if (bootstrap.state === "pending") {
    return jsonResponse({
      ok: true,
      state: "pending",
      hardware_id: hardwareId,
      claim_code: bootstrap.claim_code || "",
      claim_expires_at: bootstrap.claim_expires_at || null,
      claim_url: new URL(request.url).origin,
    });
  }

  if (bootstrap.state === "claimed") {
    return jsonResponse({
      ok: true,
      state: "claimed",
      hardware_id: hardwareId,
      device_id: bootstrap.device_id || "",
      owner_account_id: bootstrap.owner_account_id || "",
      owner_region: bootstrap.owner_region || "",
      claimed_at: bootstrap.claimed_at || null,
    });
  }

  return jsonResponse({ ok: false, error: "Unknown bootstrap state" }, 500);
}

async function handleRotateDeviceToken(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const deviceId = await findOwnedDeviceId(env, session);
  if (!deviceId) {
    return jsonResponse({ ok: false, error: "No claimed device for this account yet" }, 404);
  }

  const existing = await loadDeviceRecord(env, deviceId);
  if (!existing || !sessionOwnsDevice(session, existing)) {
    return jsonResponse({ ok: false, error: "Claimed device record missing" }, 404);
  }

  const deviceToken = randomOpaqueId(24);
  const record = {
    ...existing,
    token_hash: await sha256B64Url(deviceToken),
    token_hint: deviceToken.slice(-4),
    updated_at: Date.now(),
  };

  const save = await saveDeviceRecord(env, deviceId, record);
  if (!save.save.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "Could not rotate device token",
        kv_limited: !!save.save?.kvLimited,
      },
      save.save?.kvLimited ? 429 : 500
    );
  }

  return jsonResponse({
    ok: true,
    device_id: deviceId,
    device_token: deviceToken,
    token_hint: record.token_hint || null,
  });
}

async function handleFactoryResetDevice(request, env) {
  const session = await requireSession(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const deviceId = await findOwnedDeviceId(env, session);
  if (!deviceId) {
    return jsonResponse({ ok: false, error: "No claimed GUARD for this account yet" }, 404);
  }

  const existing = await loadDeviceRecord(env, deviceId);
  if (!existing || !sessionOwnsDevice(session, existing)) {
    return jsonResponse({ ok: false, error: "Claimed device record missing" }, 404);
  }

  const hardwareId = normalizeHardwareId(existing.hardware_id);
  if (!hardwareId) {
    return jsonResponse({ ok: false, error: "GUARD is missing its hardware identity" }, 409);
  }

  const bootstrap = await loadBootstrapRecord(env, hardwareId);
  if (!bootstrap?.bootstrap_secret_hash) {
    return jsonResponse({ ok: false, error: "GUARD bootstrap record missing" }, 404);
  }

  if (bootstrap.claim_code) {
    await deleteClaimLookup(env, bootstrap.claim_code);
  }

  const pending = await createPendingBootstrap(env, hardwareId, bootstrap.bootstrap_secret_hash);
  if (!pending.ok) {
    return jsonResponse(
      {
        ok: false,
        error: pending.error || "Could not create a fresh claim code",
        kv_limited: !!pending.save?.kvLimited,
      },
      pending.save?.kvLimited ? 429 : 500
    );
  }

  const resetCommand = `factory-${randomOpaqueId(9)}`;
  const mailboxResult = await saveMailboxPatch(env, deviceId, {
    control_factory_reset: resetCommand,
    control_factory_reset_at: Date.now(),
    message: "Factory reset requested",
  });

  if (!mailboxResult.save.ok) {
    await saveBootstrapRecord(env, hardwareId, bootstrap);
    await deleteClaimLookup(env, pending.record?.claim_code);
    return jsonResponse(
      {
        ok: false,
        error: "Could not send the factory reset command to GUARD",
        kv_limited: !!mailboxResult.save?.kvLimited,
      },
      mailboxResult.save?.kvLimited ? 429 : 500
    );
  }

  const archivedRecord = {
    ...existing,
    factory_reset_requested_at: Date.now(),
    updated_at: Date.now(),
  };
  await saveDeviceRecord(env, deviceId, archivedRecord);
  await deleteOwnerDeviceMapping(env, session.region, session.accountId);

  return jsonResponse({
    ok: true,
    reset_requested: true,
    device_id: deviceId,
    reset_command: resetCommand,
    claim_code: pending.record.claim_code,
    claim_expires_at: pending.record.claim_expires_at,
    message: "GUARD is resetting. It will erase Wi-Fi and pairing, then restart into Bluetooth setup.",
  });
}

async function maybeRefreshDexcomMailboxForDevice(env, deviceRecord) {
  const ownerRegion = String(deviceRecord?.owner_region || "us").trim().toLowerCase();
  const ownerAccountId = String(deviceRecord?.owner_account_id || "").trim();
  if (!ownerAccountId) {
    return { ok: false, skipped: true, reason: "missing_owner" };
  }

  const shouldRefresh = await shouldRefreshOwnerDexcomNow(
    env,
    ownerRegion,
    ownerAccountId,
    DEXCOM_DEVICE_SYNC_MIN_MS
  );

  if (!shouldRefresh.allow || !shouldRefresh.record) {
    return {
      ok: !!shouldRefresh.ok,
      skipped: true,
      reason: shouldRefresh.reason || "throttled",
    };
  }

  return await refreshDexcomForSession(env, shouldRefresh.record, {
    minutes: DEXCOM_DEFAULT_MINUTES,
    maxCount: DEXCOM_DEFAULT_MAX_COUNT,
    syncMailbox: true,
  });
}

async function handleMailboxGet(request, env) {
  // GET /mailbox is intentionally simple:
  // it returns the full mailbox for one authenticated device instead of one
  // global mailbox shared by every robot.
  const context = await resolveDeviceContext(request, env, {
    allowSession: true,
    allowDeviceToken: true,
    createIfMissing: false,
  });

  if (!context.ok) {
    return jsonResponse({ ok: false, error: context.error }, context.status || 401);
  }

  if (context.auth === "device") {
    try {
      await maybeRefreshDexcomMailboxForDevice(env, context.device);
    } catch (error) {
      console.warn(
        "Guardian mailbox-triggered Dexcom refresh failed",
        JSON.stringify({
          deviceId: context.deviceId,
          error: String(error?.message || error || "unknown"),
        })
      );
    }
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
  const context = await requireOwnedDevice(request, env, { createIfMissing: false });
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

      if (url.pathname === "/device/bootstrap" && request.method === "POST") {
        return await handleDeviceBootstrap(request, env);
      }

      if (url.pathname === "/device/claim" && request.method === "POST") {
        return await handleClaimDevice(request, env);
      }

      if (url.pathname === "/device" && request.method === "GET") {
        return await handleDeviceInfo(request, env);
      }

      if (url.pathname === "/device/bootstrap-status" && request.method === "GET") {
        return await handleBootstrapStatus(request, env);
      }

      if (url.pathname === "/device/rotate-token" && request.method === "POST") {
        return await handleRotateDeviceToken(request, env);
      }

      if (url.pathname === "/device/factory-reset" && request.method === "POST") {
        return await handleFactoryResetDevice(request, env);
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
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncDexcomMailboxesForActiveSessions(env));
  },
};

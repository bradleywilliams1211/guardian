
    const menuToggle = document.getElementById('menuToggle');
    const nav = document.getElementById('nav');

    if (menuToggle) {
      menuToggle.addEventListener('click', () => {
        nav.classList.toggle('open');
      });
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add('is-visible');
      });
    }, { threshold: 0.12 });

    document.querySelectorAll('.reveal').forEach((el, i) => {
      if (!el.classList.contains('is-visible')) {
        el.style.transitionDelay = Math.min(i * 45, 220) + 'ms';
      }
      observer.observe(el);
    });

    const countUp = (el) => {
      const target = Number(el.dataset.count || 0);
      const duration = 1100;
      const start = performance.now();

      const tick = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(target * eased);
        if (progress < 1) requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    };

    document.querySelectorAll('[data-count]').forEach((el) => {
      if (el.dataset.liveCount === "trusted-users") return;
      countUp(el);
    });

    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', () => nav.classList.remove('open'));
    });
    const API_BASE = ""; // set to your worker domain if needed, e.g. "https://YOUR_WORKER.workers.dev"
    const DEVICE_ID_KEY = "guard_current_device_id";
    const LOCAL_MAILBOX_KEY = "guard_local_mailbox";
    const GUARD_BLE_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
    const GUARD_BLE_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
    const GUARD_BLE_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
    const BLE_PENDING_CLAIM_CODE_KEY = "guard_pending_claim_code";

    /*
      DEVICE OVERVIEW

      The old prototype had one global mailbox for every ESP32.
      The safer version gives each ESP32 its own device id, its own heartbeat,
      and its own mailbox.

      Important:
      - device_id is okay to store in localStorage because it is not a secret
      - device_token is secret and should stay private
    */
    let currentDeviceId = "";
    let guardBleSession = {
      device: null,
      server: null,
      rx: null,
      tx: null,
    };

    function getCurrentDeviceId() {
      if (currentDeviceId) return currentDeviceId;

      try {
        currentDeviceId = localStorage.getItem(DEVICE_ID_KEY) || "";
      } catch {
        currentDeviceId = "";
      }

      return currentDeviceId;
    }

    function setCurrentDeviceId(deviceId) {
      currentDeviceId = String(deviceId || "").trim().toLowerCase();

      try {
        if (currentDeviceId) {
          localStorage.setItem(DEVICE_ID_KEY, currentDeviceId);
        } else {
          localStorage.removeItem(DEVICE_ID_KEY);
        }
      } catch {}

      return currentDeviceId;
    }

    function buildDeviceApiUrl(path) {
      const url = new URL((API_BASE || "") + path, window.location.origin);
      const deviceId = getCurrentDeviceId();

      if (deviceId) {
        url.searchParams.set("device_id", deviceId);
      }

      if (API_BASE) {
        return url.toString();
      }

      return url.pathname + url.search;
    }

    function loadLocalMailbox() {
      try {
        const raw = localStorage.getItem(LOCAL_MAILBOX_KEY) || "";
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
      } catch {
        return {};
      }
    }

    function saveLocalMailboxPatch(patch) {
      const mailbox = {
        ...loadLocalMailbox(),
        ...(patch || {}),
        updatedAt: Date.now()
      };

      try {
        localStorage.setItem(LOCAL_MAILBOX_KEY, JSON.stringify(mailbox));
      } catch {}

      return mailbox;
    }

/*
  MAILBOX OVERVIEW

  The mailbox is the easiest way for the website to send custom values to the
  ESP32. Instead of building a custom route for every variable, the site writes
  keys into one shared JSON object.

  Example:
  await setMailbox({
    current_glucose: 142,
    predicted_far: 185,
    message: "Drink water",
    robot_mode: "alert"
  });

  The Worker stores that object in KV.
  The ESP32 polls /mailbox and reads any keys it wants.

  Rule of thumb:
  - Need one more value on the ESP32? Add one more key here.
*/
async function getMailbox() {
  // Returns the whole mailbox object.
  // This is useful for debugging or for updating UI with the current shared state.
  if (!getCurrentDeviceId()) {
    // App-only mode:
    // if no GUARD is paired yet, keep website-only settings locally so the chart
    // can still use thresholds and the user can still use Guardian without hardware.
    return loadLocalMailbox();
  }

  const res = await fetch(buildDeviceApiUrl("/mailbox"), {
    cache: "no-store",
    credentials: "same-origin"
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load mailbox");
  }

  return data.mailbox || {};
}

async function setMailbox(patch) {
  // "patch" means "only the keys you want to change".
  // Example:
  // await setMailbox({ message: "Hello" })
  //
  // That updates just "message" and leaves the other mailbox keys alone.
  if (!getCurrentDeviceId()) {
    return saveLocalMailboxPatch(patch);
  }

  const res = await fetch(buildDeviceApiUrl("/mailbox"), {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(patch || {}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to save mailbox");
  }

  return data.mailbox || {};
}

window.getMailbox = getMailbox;
window.setMailbox = setMailbox;
window.getCurrentDeviceId = getCurrentDeviceId;

// Legacy aliases for older code.
// New code should prefer getMailbox / setMailbox because the name matches
// what the feature actually is.
window.getDeviceState = getMailbox;
window.setDeviceState = setMailbox;

/*
  BLUETOOTH SETUP OVERVIEW

  The ESP32 now exposes a tiny Bluetooth setup service so Guardian can send the
  user's Wi-Fi name/password directly from the website. This is only for local
  onboarding. After setup, the robot still uses Wi-Fi for /mailbox and
  /heartbeat.

  Browser -> Bluetooth -> ESP32 -> Wi-Fi -> Worker

  We keep the pairing code in localStorage temporarily so:
  - the Home setup card can show it right away
  - the login claim card can auto-fill it later
*/
function hasWebBluetoothSupport() {
  return !!(navigator.bluetooth && window.isSecureContext);
}

function setBleSetupState(message, tone = "neutral") {
  const el = document.getElementById("bleSetupState");
  if (!el) return;

  el.textContent = message || "";

  if (tone === "error") {
    el.style.color = "#b42318";
    return;
  }

  if (tone === "success") {
    el.style.color = "#0b8f2f";
    return;
  }

  if (tone === "muted") {
    el.style.color = "grey";
    return;
  }

  el.style.color = "var(--ink)";
}

function setBleFallbackText(message) {
  const el = document.getElementById("bleSetupFallback");
  if (!el) return;
  el.textContent = message || "";
}

function showBleFallbackGuidance(reason = "") {
  const extra = reason ? (" " + reason) : "";
  setBleSetupState(
    "Use GUARD-SETUP instead: open your phone Wi-Fi settings, join GUARD-SETUP, enter your home Wi-Fi, then return here to claim the code." + extra,
    "muted"
  );
  setBleFallbackText(
    "Fallback steps: 1) join GUARD-SETUP, 2) submit Wi-Fi, 3) claim the code on Guardian."
  );
}

function setBleSetupBusy(busy) {
  const btn = document.getElementById("bleSetupButton");
  if (!btn) return;

  btn.disabled = !!busy;
  btn.textContent = busy ? "Connecting..." : "Connect with Bluetooth";
}

function getPendingClaimCode() {
  try {
    return (localStorage.getItem(BLE_PENDING_CLAIM_CODE_KEY) || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  } catch {
    return "";
  }
}

function syncPendingClaimCodeUI() {
  const code = getPendingClaimCode();
  const claimEl = document.getElementById("bleSetupClaim");
  const input = document.getElementById("claimCodeInput");

  if (claimEl) {
    claimEl.textContent = code ? ("Pairing code: " + code) : "";
  }

  if (input && code && !input.value.trim()) {
    input.value = code;
  }
}

function rememberPendingClaimCode(code) {
  const cleanCode = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  try {
    if (cleanCode) {
      localStorage.setItem(BLE_PENDING_CLAIM_CODE_KEY, cleanCode);
    } else {
      localStorage.removeItem(BLE_PENDING_CLAIM_CODE_KEY);
    }
  } catch {}

  syncPendingClaimCodeUI();
  return cleanCode;
}

function clearPendingClaimCode() {
  rememberPendingClaimCode("");
}

function decodeBleValue(value) {
  const bytes = value instanceof DataView
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value?.buffer || value || []);

  return new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim();
}

function parseBleStatus(value) {
  const text = decodeBleValue(value);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function applyGuardBleStatus(status) {
  if (!status) return;

  const claimCode = rememberPendingClaimCode(status.claim_code || "");
  const helpText = status.message || "Guardian sent a Bluetooth status update.";
  const hint = status.network_hint ? (" " + status.network_hint) : "";
  const unavailableReason = status.bluetooth_unavailable_reason
    ? (" " + status.bluetooth_unavailable_reason)
    : "";
  const state = String(status.state || "").trim().toLowerCase();

  if (state === "ready_for_wifi") {
    if (status.supports_bluetooth_setup === false) {
      showBleFallbackGuidance((status.bluetooth_unavailable_reason || "").trim());
      return;
    }
    setBleSetupState(helpText, "neutral");
    return;
  }

  if (state === "connecting_wifi" || state === "wifi_connected") {
    setBleSetupState(helpText, "neutral");
    return;
  }

  if (state === "claim_required") {
    setBleSetupState(helpText, "success");
    if (claimCode) {
      const stateEl = document.getElementById("device-claim-state");
      if (stateEl && !stateEl.textContent.trim()) {
        stateEl.textContent = "Pairing code received. Log in and click Claim Device when ready.";
      }
    }
    return;
  }

  if (state === "claimed") {
    clearPendingClaimCode();
    setBleSetupState(helpText, "success");
    return;
  }

  if (state === "wifi_error" || state === "bootstrap_error" || state === "error") {
    setBleSetupState(helpText + hint + unavailableReason, "error");
    return;
  }

  setBleSetupState(helpText, "neutral");
}

function handleGuardBleNotification(event) {
  const status = parseBleStatus(event.target.value);
  applyGuardBleStatus(status);
}

function handleGuardBleDisconnect() {
  guardBleSession = {
    device: null,
    server: null,
    rx: null,
    tx: null,
  };

  setBleSetupState(
    "Bluetooth connection closed. Reconnect if you want to send Wi-Fi again.",
    "muted"
  );
}

async function writeBleValue(characteristic, text) {
  const bytes = new TextEncoder().encode(text);

  if (typeof characteristic.writeValueWithResponse === "function") {
    return characteristic.writeValueWithResponse(bytes);
  }

  if (typeof characteristic.writeValue === "function") {
    return characteristic.writeValue(bytes);
  }

  throw new Error("This browser could not write to the GUARD Bluetooth service.");
}

async function connectGuardBluetooth() {
  if (guardBleSession.rx && guardBleSession.tx && guardBleSession.device?.gatt?.connected) {
    return guardBleSession;
  }

  if (!hasWebBluetoothSupport()) {
    throw new Error("Web Bluetooth is not available here. Use Chrome or Edge, or fall back to GUARD-SETUP.");
  }

  setBleSetupState("Choose your GUARD from the Bluetooth picker…");

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "GUARD" }],
      optionalServices: [GUARD_BLE_SERVICE_UUID],
    });
  } catch (err) {
    if (err?.name === "NotFoundError") {
      throw new Error(
        "No GUARD was found in Bluetooth. On the current ESP32-C3 firmware, Bluetooth setup may be disabled, so use GUARD-SETUP instead."
      );
    }
    throw err;
  }

  device.addEventListener("gattserverdisconnected", handleGuardBleDisconnect);

  setBleSetupState("Connecting to " + (device.name || "GUARD") + "…");

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(GUARD_BLE_SERVICE_UUID);
  const rx = await service.getCharacteristic(GUARD_BLE_RX_UUID);
  const tx = await service.getCharacteristic(GUARD_BLE_TX_UUID);

  tx.addEventListener("characteristicvaluechanged", handleGuardBleNotification);
  await tx.startNotifications();

  guardBleSession = { device, server, rx, tx };

  try {
    const currentStatus = await tx.readValue();
    applyGuardBleStatus(parseBleStatus(currentStatus));
  } catch {}

  return guardBleSession;
}

async function startGuardBluetoothSetup() {
  const ssid = document.getElementById("bleWifiSsid")?.value.trim() || "";
  const password = document.getElementById("bleWifiPassword")?.value || "";

  if (!ssid) {
    setBleSetupState("Enter your home Wi-Fi name first.", "error");
    return;
  }

  clearPendingClaimCode();
  setBleSetupBusy(true);

  try {
    const session = await connectGuardBluetooth();
    const payload = JSON.stringify({
      action: "provision_wifi",
      ssid,
      password,
    });

    await writeBleValue(session.rx, payload);
    setBleSetupState("Wi-Fi sent to GUARD. Waiting for the robot to report back…", "neutral");
  } catch (err) {
    const message = err?.message || "Bluetooth setup failed.";
    setBleSetupState(message, "error");
    if (
      /GUARD-SETUP/i.test(message) ||
      /Bluetooth setup may be disabled/i.test(message) ||
      /Web Bluetooth is not available/i.test(message)
    ) {
      showBleFallbackGuidance();
    }
  } finally {
    setBleSetupBusy(false);
  }
}

function initGuardBluetoothSetup() {
  syncPendingClaimCodeUI();

  if (!hasWebBluetoothSupport()) {
    setBleSetupState(
      "This browser does not support Guardian Bluetooth setup. Use Chrome/Edge or fall back to GUARD-SETUP.",
      "muted"
    );
    setBleFallbackText(
      "This current setup should use GUARD-SETUP on unsupported browsers like Safari/iPhone."
    );
    return;
  }

  setBleSetupState(
    "Guardian can try Bluetooth here, but if no GUARD appears use GUARD-SETUP right away. Current ESP32-C3 firmware may prefer the fallback.",
    "muted"
  );
  setBleFallbackText(
    "If your GUARD does not appear in the picker, switch to GUARD-SETUP. That is expected on the current ESP32-C3 firmware."
  );
}

window.startGuardBluetoothSetup = startGuardBluetoothSetup;

/*
  DEVICE HELPERS

  These are developer/support helpers.
  Regular customers should use the claim-code card on the login screen instead.

  Example:
    const info = await getDeviceInfo();
    console.log(info.device_id);

    const creds = await rotateDeviceToken();
    console.log(creds.device_id, creds.device_token);
*/
async function getDeviceInfo() {
  const res = await fetch("/device", {
    cache: "no-store",
    credentials: "same-origin"
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to load device info");
  }

  if (data.device_id) {
    setCurrentDeviceId(data.device_id);
  }

  return data;
}

async function rotateDeviceToken() {
  const res = await fetch("/device/rotate-token", {
    method: "POST",
    credentials: "same-origin"
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Failed to rotate device token");
  }

  if (data.device_id) {
    setCurrentDeviceId(data.device_id);
  }

  return data;
}

window.getDeviceInfo = getDeviceInfo;
window.rotateDeviceToken = rotateDeviceToken;

function setClaimCardVisible(visible, options = {}) {
  const card = document.getElementById("deviceClaimCard");
  const helpEl = document.getElementById("device-claim-help");
  const stateEl = document.getElementById("device-claim-state");

  if (card) {
    card.style.display = visible ? "block" : "none";
  }

  if (helpEl && typeof options.help === "string") {
    helpEl.textContent = options.help;
  }

  if (stateEl && typeof options.state === "string") {
    stateEl.textContent = options.state;
  }

  if (visible) {
    syncPendingClaimCodeUI();
  }
}

async function claimDeviceFromCode() {
  const input = document.getElementById("claimCodeInput");
  const stateEl = document.getElementById("device-claim-state");
  const rawCode = (input?.value || getPendingClaimCode()).trim();
  const claimCode = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (!claimCode) {
    if (stateEl) stateEl.textContent = "Enter the pairing code shown after Bluetooth or GUARD-SETUP setup.";
    return;
  }

  if (stateEl) stateEl.textContent = "Claiming device…";

  try {
    const res = await fetch("/device/claim", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_code: claimCode })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Could not claim device");
    }

    if (data.device_id) {
      setCurrentDeviceId(data.device_id);
    }

    if (input) input.value = "";
    clearPendingClaimCode();
    if (stateEl) stateEl.textContent = "Device claimed. Finishing setup…";
    setClaimCardVisible(false, { state: "" });
    await refreshSessionState();
    await enterDashboard();
  } catch (err) {
    if (stateEl) {
      stateEl.textContent = err?.message || "Could not claim device";
    }
  }
}

window.claimDeviceFromCode = claimDeviceFromCode;

async function loadTrustedUsersCount() {
  const el = document.getElementById("trusted-users-count");
  if (!el) return;

  try {
    const res = await fetch(API_BASE + "/trusted-users-count");
    const text = await res.text();
    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    const count = Number(data?.count);
    if (!res.ok || !data?.ok || !Number.isFinite(count) || count < 0) {
      throw new Error(data?.error || text || "Failed to load trusted users count.");
    }

    setTrustedUsersCount(count);
  } catch {
    const fallback = Number(el.dataset.count || 0);
    el.textContent = Number.isFinite(fallback) ? String(fallback) : "0";
  }
}

function setTrustedUsersCount(count, options = {}) {
  const el = document.getElementById("trusted-users-count");
  if (!el) return;

  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  el.dataset.count = String(safeCount);

  if (options.animate === false) {
    el.textContent = String(safeCount);
    return;
  }

  el.textContent = "0";
  countUp(el);
}

void loadTrustedUsersCount();

const DEMO_MODE_KEY = "guard_demo_mode";
const DEMO_USER = "dev";
const DEMO_PASS = "123";
const DEMO_TOKEN_PREFIX = "demo:";
let hasServerSession = false;

let previousView = "landing";
const year = new Date().getFullYear();

function closeAllFooterPages() {
  const footerPagesWrap = document.getElementById("footer-pages");
  const footerPages = document.querySelectorAll(".footer-page");

  if (footerPagesWrap) footerPagesWrap.style.display = "none";

  footerPages.forEach(page => {
    page.classList.remove("active");
  });
}

function openGuardianContent(e) {
  if (e) e.preventDefault();

  const landing = document.getElementById("landing-page");
  const guardian = document.getElementById("guardiancontent");

  closeAllFooterPages();

  if (landing) {
    landing.classList.add("hide");

    setTimeout(() => {
      landing.style.display = "none";
      if (guardian) guardian.classList.add("active");
      openlogin();
      window.scrollTo({ top: 0, behavior: "auto" });
    }, 300);
  } else {
    if (guardian) guardian.classList.add("active");
    openlogin();
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

function closeGuardianContent() {
  const landing = document.getElementById("landing-page");
  const guardian = document.getElementById("guardiancontent");

  closeAllFooterPages();

  if (guardian) guardian.classList.remove("active");

  if (landing) {
    landing.style.display = "block";
    requestAnimationFrame(() => {
      landing.classList.remove("hide");
    });
  }

  syncFloatingFooter();
  window.scrollTo({ top: 0, behavior: "auto" });
}
function toggleLanguageMenu() {
  const menu = document.getElementById("languageMenu");
  if (menu) menu.classList.toggle("show");
}

function setGoogleLanguage(lang) {
  const combo = document.querySelector(".goog-te-combo");

  if (!combo) {
    alert("Translator is still loading. Try again in a second.");
    return;
  }

  combo.value = lang;
  combo.dispatchEvent(new Event("change"));

  const menu = document.getElementById("languageMenu");
  if (menu) menu.classList.remove("show");
}

document.addEventListener("click", function(e){
  const wrap = document.querySelector(".footer-language-wrap");
  if (!wrap) return;
  if (!wrap.contains(e.target)) {
    document.getElementById("languageMenu")?.classList.remove("show");
  }
});

function googleTranslateElementInit() {
  new google.translate.TranslateElement({
    pageLanguage: "en",
    autoDisplay: false
  }, "google_translate_element");
}

document.getElementById("copyright").textContent =
"© " + year + " Guardian. All rights reserved.";

const birthDate = new Date(2007, 10, 12); // YEAR, MONTH(0-11), DAY

function getExactAge(birth) {
  const today = new Date();

  let age = today.getFullYear() - birth.getFullYear();

  const monthDiff = today.getMonth() - birth.getMonth();
  const dayDiff = today.getDate() - birth.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age--;
  }

  return age;
}

const ageEl = document.getElementById("age");
if (ageEl) {
  ageEl.textContent = getExactAge(birthDate);
}

function closeFooterPages() {
  const landing = document.getElementById("landing-page");
  const guardian = document.getElementById("guardiancontent");
  const footerPagesWrap = document.getElementById("footer-pages");
  const footerPages = document.querySelectorAll(".footer-page");

  if (footerPagesWrap) footerPagesWrap.style.display = "none";
  footerPages.forEach(page => page.classList.remove("active"));

  if (lastMainView === "guardian") {
    if (landing) {
      landing.style.display = "none";
      landing.classList.add("hide");
    }

    if (guardian) guardian.classList.add("active");
  } else {
    if (guardian) guardian.classList.remove("active");

    if (landing) {
      landing.style.display = "block";
      requestAnimationFrame(() => {
        landing.classList.remove("hide");
      });
    }

  }

  syncFloatingFooter();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

let lastMainView = "landing";

function showFooterPage(pageId) {
  const landing = document.getElementById("landing-page");
  const guardian = document.getElementById("guardiancontent");
  const footerPagesWrap = document.getElementById("footer-pages");
  const footerPages = document.querySelectorAll(".footer-page");

  if (guardian && guardian.classList.contains("active")) {
    lastMainView = "guardian";
  } else {
    lastMainView = "landing";
  }

  if (landing) landing.style.display = "none";
  if (guardian) guardian.classList.remove("active");
  if (footerPagesWrap) footerPagesWrap.style.display = "block";

  footerPages.forEach(page => page.classList.remove("active"));

  const target = document.getElementById(pageId);
  if (target) target.classList.add("active");

  syncFloatingFooter();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function setRobotAnimal(type) {
  if (!ROBOT_MODELS[type]) return;
  if (currentRobotAnimal === type) return;

  currentRobotAnimal = type;
  loadRobotModel(type);

  document.querySelectorAll(".model-card").forEach(card => {
    card.classList.toggle("active", card.dataset.animal === type);
  });
}
let modelWheelScrollTimer = null;

function updateModelWheelSelection() {
  const wheel = document.getElementById("modelWheel");
  if (!wheel) return;

  const cards = Array.from(wheel.querySelectorAll(".model-card"));
  if (!cards.length) return;

  const wheelRect = wheel.getBoundingClientRect();
  const wheelCenter = wheelRect.left + wheelRect.width / 2;

  let closestCard = null;
  let closestDist = Infinity;

  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    const cardCenter = rect.left + rect.width / 2;
    const dist = Math.abs(cardCenter - wheelCenter);

    card.classList.remove("near", "active");

    if (dist < 140) {
      card.classList.add("near");
    }

    if (dist < closestDist) {
      closestDist = dist;
      closestCard = card;
    }
  });

  if (!closestCard) return;

  closestCard.classList.add("active");

  const animal = closestCard.dataset.animal;
  if (animal && animal !== currentRobotAnimal) {
    setRobotAnimal(animal);
  }
}

function snapModelWheelToCenter(smooth = true) {
  const wheel = document.getElementById("modelWheel");
  if (!wheel) return;

  const cards = Array.from(wheel.querySelectorAll(".model-card"));
  if (!cards.length) return;

  const wheelRect = wheel.getBoundingClientRect();
  const wheelCenter = wheelRect.left + wheelRect.width / 2;

  let closestCard = null;
  let closestDist = Infinity;

  cards.forEach(card => {
    const rect = card.getBoundingClientRect();
    const cardCenter = rect.left + rect.width / 2;
    const dist = Math.abs(cardCenter - wheelCenter);

    if (dist < closestDist) {
      closestDist = dist;
      closestCard = card;
    }
  });

  if (!closestCard) return;

  closestCard.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    inline: "center",
    block: "nearest"
  });
}

function initModelWheel() {
  const wheel = document.getElementById("modelWheel");
  if (!wheel || wheel.dataset.ready === "1") return;

  wheel.dataset.ready = "1";

  Array.from(wheel.querySelectorAll(".model-card")).forEach(card => {
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    card.addEventListener("click", () => {
      const animal = card.dataset.animal;
      if (!animal) return;

      setRobotAnimal(animal);
      centerModelWheelOn(animal, true);
    });

    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      card.click();
    });
  });

  wheel.addEventListener("scroll", () => {
    updateModelWheelSelection();

    clearTimeout(modelWheelScrollTimer);
    modelWheelScrollTimer = setTimeout(() => {
      snapModelWheelToCenter(true);
      updateModelWheelSelection();
    }, 90);
  }, { passive: true });

  window.addEventListener("resize", () => {
    snapModelWheelToCenter(false);
    updateModelWheelSelection();
  });

  requestAnimationFrame(() => {
    centerModelWheelOn(currentRobotAnimal, false);
    updateModelWheelSelection();
  });
}

function centerModelWheelOn(animal, smooth = true) {
  const wheel = document.getElementById("modelWheel");
  if (!wheel) return;

  const card = wheel.querySelector('.model-card[data-animal="' + animal + '"]');
  if (!card) return;

  card.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    inline: "center",
    block: "nearest"
  });
}

let robotScene = null;
let robotCamera = null;
let robotRenderer = null;
let robotControls = null;
let robotModel = null;
let robotWireframeGroup = null;
let robotAnimFrame = null;
let robotViewMode = "blueprint";
let currentRobotAnimal = "dog";
let cinematicCameraEnabled = false;
let cinematicAngle = 0;

const ROBOT_MODELS = {
  dog: {
    path: "/models/Assembly/Argos_asm.glb",
    scale: [1.2, 1.2, 1.2],
    position: [0, -0.6, 0],
    rotation: [0, 0, 0]
  },

  bird: {
    path: "/models/Assembly/bird.glb",
    scale: [1.2, 1.2, 1.2],
    position: [0, -0.6, 0],
    rotation: [0, 0, 0]
  },
    turtle: {
    path: "/models/Assembly/turtle.glb",
    scale: [1.2, 1.2, 1.2],
    position: [0, -0.6, 0],
    rotation: [0, 0, 0]
  },
};
/* ============================================================
   ROBOT MODEL LIBRARY
   ============================================================ */


function showRobotViewerMessage(message) {
  const wrap = document.getElementById("robotModelViewer");
  if (!wrap) return;

  let msg = document.getElementById("robotModelMessage");

  if (!msg) {
    msg = document.createElement("div");
    msg.id = "robotModelMessage";
    msg.style.position = "absolute";
    msg.style.inset = "0";
    msg.style.display = "flex";
    msg.style.alignItems = "center";
    msg.style.justifyContent = "center";
    msg.style.textAlign = "center";
    msg.style.padding = "16px";
    msg.style.color = "white";
    msg.style.opacity = ".85";
    msg.style.zIndex = "5";
    msg.style.pointerEvents = "none";
    wrap.appendChild(msg);
  }

  msg.innerHTML = message;
}

function clearRobotViewerMessage() {
  const msg = document.getElementById("robotModelMessage");
  if (msg) msg.remove();
}

function initRobotViewer() {
  const wrap = document.getElementById("robotModelViewer");
  if (!wrap) return;

  if (robotRenderer) {
    resizeRobotViewer();
    return;
  }

  wrap.innerHTML = "";

  const width = wrap.clientWidth || 300;
  const height = wrap.clientHeight || 300;

  robotScene = new THREE.Scene();

  robotCamera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000);
  robotCamera.position.set(0, 1.2, 4.8);

  robotRenderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });
  robotRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  robotRenderer.setSize(width, height);
  wrap.appendChild(robotRenderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 1.7);
  robotScene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(3, 4, 5);
  robotScene.add(keyLight);

  const topLight = new THREE.DirectionalLight(0xffffff, 0.6);
  topLight.position.set(0, 5, 2);

  robotScene.add(topLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
  fillLight.position.set(-3, 2, -4);
  robotScene.add(fillLight);

  robotControls = new THREE.OrbitControls(robotCamera, robotRenderer.domElement);
  robotControls.enableDamping = true;
  robotControls.enablePan = false;
  robotControls.enableZoom = false;
  robotControls.autoRotate = true;
  robotControls.autoRotateSpeed = 1.4;


  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.45, 0.05, 48),
    new THREE.MeshBasicMaterial({
      color: 0x09B02C,
      transparent: true,
      opacity: 0.18
    })
  );

  platform.position.y = -1.15;
  robotScene.add(platform);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.4, 32),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.08
    })
  );

  shadow.rotation.x = -Math.PI/2;
  shadow.position.y = -1.16;

  robotScene.add(shadow);
  const ringGeo = new THREE.RingGeometry(1.5, 1.65, 64);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x09B02C,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide
  });

  const ring = new THREE.Mesh(ringGeo, ringMat);

  ring.rotation.x = -Math.PI/2;
  ring.position.y = -1.14;

  robotScene.add(ring);

  loadRobotModel(currentRobotAnimal);
  animateRobotViewer();

  window.addEventListener("resize", resizeRobotViewer);
}

function loadRobotModel(modelKey = "dog") {
  const config = ROBOT_MODELS[modelKey];
  if (!config) return;

  currentRobotAnimal = modelKey;
  document.querySelectorAll(".model-card").forEach(card => {
    card.classList.toggle("active", card.dataset.animal === modelKey);
  });

  const wrap = document.getElementById("robotModelViewer");
  if (wrap) {
    wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:grey;opacity:.8;text-align:center;padding:16px;">Loading ' + modelKey + ' model...</div>';
  }

  const loader = new THREE.GLTFLoader();

  const dracoLoader = new THREE.DRACOLoader();
  dracoLoader.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/");
  loader.setDRACOLoader(dracoLoader);

  loader.load(
    config.path,

    function (gltf) {
      if (wrap && robotRenderer && !wrap.contains(robotRenderer.domElement)) {
        wrap.innerHTML = "";
        wrap.appendChild(robotRenderer.domElement);
      }

      if (robotModel) {
        robotScene.remove(robotModel);
      }

      if (robotWireframeGroup) {
        robotScene.remove(robotWireframeGroup);
        robotWireframeGroup = null;
      }

      robotModel = gltf.scene;

      robotModel.scale.set(config.scale[0], config.scale[1], config.scale[2]);
      robotModel.position.set(config.position[0], config.position[1], config.position[2]);

      if (config.rotation) {
        robotModel.rotation.set(config.rotation[0], config.rotation[1], config.rotation[2]);
      } else {
        robotModel.rotation.set(0, 0, 0);
      }
      robotModel.traverse((child) => {
        if (!child.isMesh) return;

        if (child.geometry) {
          child.geometry.computeBoundingBox?.();
          child.geometry.computeBoundingSphere?.();
        }

        /* preserve skinned mesh behavior */
        if (child.isSkinnedMesh) {
          child.frustumCulled = false;
          child.bindMode = "attached";
          child.normalizeSkinWeights();
        }

        /* clone materials safely without breaking rigged rendering */
        if (Array.isArray(child.material)) {
          child.material = child.material.map((mat) => {
            const newMat = mat.clone();

            if ("color" in newMat) newMat.color = new THREE.Color(0x3a4a42);
            if ("transparent" in newMat) newMat.transparent = true;
            if ("opacity" in newMat) newMat.opacity = 0.9;
            if ("emissiveIntensity" in newMat) newMat.emissiveIntensity = 0.12;
            if ("metalness" in newMat) newMat.metalness = 0.45;
            if ("roughness" in newMat) newMat.roughness = 0.35;
            if ("side" in newMat) newMat.side = THREE.DoubleSide;
            if ("skinning" in newMat) newMat.skinning = child.isSkinnedMesh;

            return newMat;
          });
        } else if (child.material) {
          const newMat = child.material.clone();

          if ("color" in newMat) newMat.color = new THREE.Color(0x3a4a42);
          if ("transparent" in newMat) newMat.transparent = true;
          if ("opacity" in newMat) newMat.opacity = 0.9;
          if ("emissive" in newMat) newMat.emissive = new THREE.Color(0x0a2a14);
          if ("emissiveIntensity" in newMat) newMat.emissiveIntensity = 0.15;
          if ("metalness" in newMat) newMat.metalness = 0.45;
          if ("roughness" in newMat) newMat.roughness = 0.35;
          if ("side" in newMat) newMat.side = THREE.DoubleSide;
          if ("skinning" in newMat) newMat.skinning = child.isSkinnedMesh;

          child.material = newMat;
        }
      });

      robotScene.add(robotModel);
      applyRobotViewMode(robotViewMode);
      fitRobotCamera();
    },

    function (progress) {
      const pct = progress.total ? (progress.loaded / progress.total * 100).toFixed(1) : "…";
      console.log("Loading model:", modelKey, pct + "%");
    },

    function (error) {
      console.error("Model failed to load:", modelKey, error);

      if (wrap) {
        wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:grey;opacity:.8;text-align:center;padding:16px;">' + modelKey + ' model is not available yet.<br>Missing file: ' + config.path + '</div>';
      }
    }
  );
}

function fitRobotCamera() {
  if (!robotModel || !robotCamera || !robotControls) return;

  const box = new THREE.Box3().setFromObject(robotModel);
  if (box.isEmpty()) return;

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  robotControls.target.copy(center);
  robotCamera.position.set(center.x, center.y + maxDim * 0.35, center.z + maxDim * 2.2);
  robotCamera.near = Math.max(0.01, maxDim / 100);
  robotCamera.far = Math.max(100, maxDim * 20);
  robotCamera.updateProjectionMatrix();
  robotControls.update();
}

function buildWireframeGroupFromModel(model) {
  const wfGroup = new THREE.Group();

  model.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;

    /* skip skinned meshes because edge overlays do not follow bone deformation correctly */
    if (child.isSkinnedMesh) return;

    const edges = new THREE.EdgesGeometry(child.geometry);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x7dff9a,
        transparent: true,
        opacity: 0.95
      })
    );

    line.position.copy(child.position);
    line.rotation.copy(child.rotation);
    line.scale.copy(child.scale);
    wfGroup.add(line);
  });

  return wfGroup;
}

function applyRobotViewMode(mode) {
  robotViewMode = mode;
  if (!robotModel) return;

  if (robotWireframeGroup) {
    robotScene.remove(robotWireframeGroup);
    robotWireframeGroup = null;
  }

  robotModel.traverse((child) => {
    if (!child.isMesh || !child.material) return;

    const materials = Array.isArray(child.material) ? child.material : [child.material];

    materials.forEach((mat) => {
      if (!mat) return;

      if (mode === "solid") {
        mat.wireframe = false;
        mat.opacity = 0.92;
        mat.transparent = true;
        if ("emissive" in mat) mat.emissive = new THREE.Color(0x09B02C);
        if ("emissiveIntensity" in mat) mat.emissiveIntensity = 0.22;
      }

      if (mode === "wireframe") {
        mat.wireframe = false;
        mat.opacity = 0.10;
        mat.transparent = true;
        if ("emissive" in mat) mat.emissive = new THREE.Color(0x09B02C);
        if ("emissiveIntensity" in mat) mat.emissiveIntensity = 0.35;
      }

      if (mode === "blueprint") {
        mat.wireframe = false;
        mat.opacity = 0.22;
        mat.transparent = true;
        if ("emissive" in mat) mat.emissive = new THREE.Color(0x09B02C);
        if ("emissiveIntensity" in mat) mat.emissiveIntensity = 0.42;
      }

      if ("skinning" in mat) mat.skinning = child.isSkinnedMesh;
      if ("side" in mat) mat.side = THREE.DoubleSide;
      mat.needsUpdate = true;
    });

    child.visible = true;
  });

  if (mode === "blueprint" || mode === "wireframe") {
    robotWireframeGroup = buildWireframeGroupFromModel(robotModel);
    robotWireframeGroup.position.copy(robotModel.position);
    robotWireframeGroup.rotation.copy(robotModel.rotation);
    robotWireframeGroup.scale.copy(robotModel.scale);
    robotScene.add(robotWireframeGroup);
  }
}

function setRobotViewMode(mode) {
  applyRobotViewMode(mode);
}

function animateRobotViewer() {
  if (!robotRenderer || !robotScene || !robotCamera) return;

  function loop() {
    robotAnimFrame = requestAnimationFrame(loop);

    if (cinematicCameraEnabled && robotModel && robotControls) {
      const box = new THREE.Box3().setFromObject(robotModel);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.z, 1) * 2.4;

      cinematicAngle += 0.0035;

      robotCamera.position.x = center.x + Math.cos(cinematicAngle) * radius;
      robotCamera.position.z = center.z + Math.sin(cinematicAngle) * radius;
      robotCamera.position.y = center.y + size.y * 0.55 + Math.sin(cinematicAngle * 1.8) * 0.2;

      robotCamera.lookAt(center);
    } else if (robotControls) {
      robotControls.update();
    }

    if (robotWireframeGroup && robotModel) {
      robotWireframeGroup.position.copy(robotModel.position);
      robotWireframeGroup.rotation.copy(robotModel.rotation);
      robotWireframeGroup.scale.copy(robotModel.scale);
    }

    robotRenderer.render(robotScene, robotCamera);
  }

  loop();
}

function resizeRobotViewer() {
  const wrap = document.getElementById("robotModelViewer");
  if (!wrap || !robotRenderer || !robotCamera) return;

  const width = wrap.clientWidth || 300;
  const height = wrap.clientHeight || 300;

  robotCamera.aspect = width / height;
  robotCamera.updateProjectionMatrix();
  robotRenderer.setSize(width, height);
}

const HERO_MODEL_CONFIG = {
  name: "Argos",
  // Load order for the hero model. The first path that exists and loads wins.
  assetCandidates: [
    "/models/Assembly/Argos_asm.glb",
    "/models/Argos_Assembly.glb",
    ROBOT_MODELS.dog.path
  ]
};

// ============================================================
// HERO MODEL CONTROL SURFACE
// Edit these blocks first when you want to change the 3D section.
// The goal is that you should not need to dig through the math below
// unless you are changing the behavior of the system itself.
// ============================================================

// Main model transform controls.
const HERO_MODEL_TRANSFORM = {
  // Base model scale before any scroll-based shrinking happens.
  // [x, y, z]
  scale: [1, 1, 1],

  // Base rig position in scene space.
  // x = left/right, y = up/down, z = forward/back
  position: [0, 0, 0],

  // Base rig rotation in radians.
  // Math.PI is 180 degrees.
  // x = tilt up/down, y = turn left/right, z = roll
  rotation: [0, Math.PI + 0.48, 0]
};

// Overall material/look controls for the hero model.
const HERO_MODEL_LOOK = {
  // Main surface color. Hex number.
  color: 0xf7fff9,

  // Glow color. Hex number.
  emissive: 0x0aa43a,

  // How strong the emissive/glow effect feels.
  emissiveIntensity: .08,

  // 0 = matte, 1 = very metallic.
  metalness: 0.38,

  // 0 = glossy, 1 = rough.
  roughness: 0.42,

  // 1 = fully visible, lower = more transparent.
  opacity: 1,

  // Usually leave true if opacity might go below 1.
  transparent: true,

  // Useful for CAD-style models where faces may be viewed from behind.
  doubleSided: true,

  // Global renderer exposure. Higher = brighter overall render.
  toneMappingExposure: 1.14
};

// Testing and playback controls.
// mode: "scroll" | "exploded" | "imploded" | "manual"
// triggerLine: lower values wait until the section is more on-screen before scroll takes over.
const HERO_MODEL_PLAYBACK = {
  // "scroll"   = normal behavior, driven by section scroll
  // "exploded" = force fully exploded for testing
  // "imploded" = force fully assembled for testing
  // "manual"   = use manualProgress below
  mode: "scroll",

  // Only used when mode = "manual".
  // 0 = assembled, 1 = fully exploded.
  manualProgress: 1,

  // Scroll does not affect the model until the section crosses this
  // portion of the viewport height.
  // Lower number = wait longer.
  triggerLine: 0.42
};

// Scroll-driven turn/orbit controls.
const HERO_MODEL_MOTION = {
  // How quickly the model catches up in reduced-motion mode.
  reducedMotionBlend: 0.24,

  // How quickly the model catches up to scroll in normal mode.
  // Higher = snappier, lower = floatier.
  scrollBlend: 0.11,

  // How smoothly the orbit angle chases its target.
  orbitLerp: 0.08,

  // Starting orbit angle of the camera around the model.
  orbitStartAngle: -0.9,

  // How much the camera orbits as scroll progresses.
  orbitTurnPerScroll: 1.55,

  // Extra rotation applied from scroll.
  // These are added on top of HERO_MODEL_TRANSFORM.rotation.
  rotateXPerScroll: -0.08,
  rotateYPerScroll: Math.PI * 1.42,
  rotateZPerScroll: 0,

  // How much the model moves vertically as scroll progresses.
  moveYPerScroll: 0.024,

  // How far the model gets pushed back when exploded.
  depthPullOnExplode: 1.18,

  // How much the model lifts while exploding.
  liftOnExplode: 0.05,

  // How much the model shrinks as it explodes so more of it stays in frame.
  scaleDownOnExplode: 0.12
};

// Camera/zoom controls.
const HERO_MODEL_CAMERA = {
  // Perspective camera settings.
  fov: 31,
  near: 0.1,
  far: 1000,

  // Initial camera position before the orbit math takes over.
  position: [0, 1.22, 6.6],

  // Base orbit radius around the model.
  radiusBase: 3.0,

  // Extra zoom-out added as the model explodes.
  radiusExplodeBoost: 2.05,

  // Extra zoom-out added as scroll increases.
  radiusScrollBoost: 0.48,

  // Vertical camera follow settings.
  heightBaseFactor: 0.28,
  heightScrollFactor: 0.12,
  heightExplodeFactor: 0.08,

  // Where the camera looks on the model vertically.
  lookAtYOffset: 0.1
};

// Light controls.
const HERO_MODEL_LIGHTING = {
  // Soft global light.
  //ambient: { color: 0xffffff, intensity: 1.35 },

  // Main directional light.
  //key: { color: 0xf5fff7, intensity: 1.75, position: [4, 5, 6] },

  // Back/rim light for edge definition.
 // rim: { color: 0x63ff93, intensity: 1.15, position: [-5, 2, -4] },

  // Hemisphere fill for a softer overall base.
  //fill: { skyColor: 0xffffff, groundColor: 0x06210f, intensity: 0.95 }
  ambient: { color: 0xffffff, intensity: 0.82 },
  key: { color: 0xffffff, intensity: 2.2, position: [5.5, 6.5, 6] },
  rim: { color: 0x63ff93, intensity: 1.2, position: [-5.5, 2.5, -5] },
  fill: { skyColor: 0xf8fff9, groundColor: 0x04170a, intensity: 0.58 }
};

// Helpful while dialing in exact part IDs for per-part explosion control.
const HERO_MODEL_DEBUG = {
  // Turn this on, reload, then open the browser console.
  // You will get a table of exact part IDs that can be pasted into
  // HERO_EXPLODE_PART_RULES below.
  logExplodePartIdsOnLoad: false
};

// Explosion controls.
const HERO_EXPLODE_CONFIG = {
  // Scroll progress range where the explosion happens.
  // 0 = very start of the section scroll, 1 = very end.
  start: 0.12,
  end: 0.42,

  // Global axis multiplier for the whole explosion.
  // Use -1 to reverse an axis, 0 to flatten it, >1 to exaggerate it.
  axis: { x: 1, y: 1, z: 1 },

  // Default fallback spread if a part has no exact rule.
  defaultDistanceBase: 0.18,
  defaultDistanceCap: 0.35,

  // Default fallback twist if a part has no exact rule.
  defaultRotationBase: 0.14,
  defaultRotationStep: 0.05,

  // Fallback Y offset used when a part sits exactly at the center.
  fallbackVerticalStep: 0.35
};

// Group rules are intentionally empty now.
// Every editable explode rule lives in HERO_EXPLODE_PART_RULES below so each
// part can be tuned individually without sharing a regex-based fallback.
const HERO_EXPLODE_GROUP_RULES = [];

// Exact per-part explode settings.
// Each part ID below can be edited individually.
// Entries with a full object keep the current hand-tuned behavior.
// Entries left as {} fall back to the automatic "fly away from the assembly center" behavior.
// Setting direction to [0, 0, 0] also uses that automatic assembly-center direction,
// which is useful when you want to test positive vs. negative distance on the same path.
// Example:
// "NOSE_REMODEL-1__1": {
//   direction: [0.2, 0, 1],
//   distance: 1.1,
//   rotationAmount: 0.04,
//   rotationAxis: [0, 1, 0]
// }
const HERO_EXPLODE_PART_RULES = {
  "FOOT_GRIP-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "THIGH_RH-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LEG_KNEE_RH-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_PIN-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_COVER-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "WRIST_RH_1-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_COVER-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_PIN-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "THIGH_RH-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LEG_KNEE_RH-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "FOOT_GRIP-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "WRIST_RH_1-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_AF11_ASM-1/MICROSERVOASSEMBLY_1_2_AF11_ASM-1/MICROSERVOSG90-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_AF11_ASM-1/MICROSERVOASSEMBLY_1_2_AF11_ASM-1/MICROSERVOARM_A2-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_AF10_ASM-1/MICROSERVOASSEMBLY_1_2_AF10_ASM-1/MICROSERVOARM_A2-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_AF10_ASM-1/MICROSERVOASSEMBLY_1_2_AF10_ASM-1/MICROSERVOSG90-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "WRIST_RH_1_MIR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LEG_KNEE_RH_MIR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "THIGH_RH_MIR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_COVER_MIR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_PIN_MIR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "FOOT_GRIP-1__3": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_1_2_MIR_ASM__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROSERVOASSEMBLY_1_2_MIR_ASM__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "BATTERY_CONTACT_NEG-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "BATTERY_HOLDER-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "BATTERY_CONTACT_POS-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__3": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/ACTUATOR-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/PINS-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/BODY1-140-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/PCB_1_ASM-1/PINS-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/PCB_1_ASM-1/BODY1-137-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "_UNSAVED__ASM-1/PCB_1_ASM-1/PINS-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__4": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LDR_CELL_THRU-HOLE_LEADED_1_ASM-1/CERAMIC_BASE_LDR_CELL_THRU-HOLE-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LDR_CELL_THRU-HOLE_LEADED_1_ASM-1/LEADS_LDR_CELL_THRU-HOLE_LEADED_ASM-1/FILLET2-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LDR_CELL_THRU-HOLE_LEADED_1_ASM-1/LEADS_LDR_CELL_THRU-HOLE_LEADED_ASM-1/FILLET1-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LDR_CELL_THRU-HOLE_LEADED_1_ASM-1/ELECTRODES_LDR_CELL_THRU-HOLE_L_ASM-1/BOSS-EXTRUDE1_1_-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LDR_CELL_THRU-HOLE_LEADED_1_ASM-1/ELECTRODES_LDR_CELL_THRU-HOLE_L_ASM-1/BOSS-EXTRUDE1_2_-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "CAPC-0805-T0_75-BN_ANYUNSPECIFI-4__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_SMD_ANYUNSPECIFIED-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "CAPC-0805-T0_75-BN_ANYUNSPECIFI-3__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_SMD_ANYUNSPECIFIED-4__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "CAPC-0805-T0_75-BN_ANYUNSPECIFI-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "CAPC-0805-T0_75-BN_ANYUNSPECIFI-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "CAPC-0805-T0_75-BN_ANYUNSPECIFI-5__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_SMD_ANYUNSPECIFIED-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_SMD_ANYUNSPECIFIED-3__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1164-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1166-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1159-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1160-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PCB-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1158-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1161-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1162-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1157-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1163-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1165-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1172-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1176-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1167-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1170-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1175-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1181-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1183-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1171-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1168-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1169-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1173-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1174-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1177-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/PADS-1178-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1179-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1180-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1182-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1188-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1193-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1189-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1190-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1192-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1187-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1200-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1194-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1186-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1184-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1185-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1191-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1195-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1197-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1198-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1196-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1199-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1204-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1211-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1212-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1203-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1202-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1201-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1205-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1206-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1209-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1207-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1208-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1210-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1214-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1216-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1213-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1217-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1215-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1218-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1224-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1221-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1226-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1225-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1219-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1220-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1223-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1228-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1222-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "PLACASUPERBOOST1000C_ASM-1/LETRAS-1227-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROUSB_BEST_ASM-1/S_X_F3LIDO2-1229-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROUSB_BEST_ASM-1/S_X_F3LIDO4-1231-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MICROUSB_BEST_ASM-1/S_X_F3LIDO3-1230-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SOT23_ASM-1/PIN-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SOT23_ASM-1/COMPONENT1-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SOT23_ASM-1/PIN-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SOT23_ASM-1/PIN-3__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-2/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-2/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-2/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MOLEX2PINSMD_ASM-1/S_X_F3LIDO3-1236-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MOLEX2PINSMD_ASM-1/S_X_F3LIDO5-1238-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MOLEX2PINSMD_ASM-1/S_X_F3LIDO1-1234-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MOLEX2PINSMD_ASM-1/S_X_F3LIDO2-1235-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MOLEX2PINSMD_ASM-1/S_X_F3LIDO4-1237-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-3/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-3/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-3/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-4/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-4/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-4/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-9/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-9/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-9/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-8/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-8/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-8/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-15/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-15/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-15/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-17/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-17/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-17/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-6/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-6/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-6/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-11/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-11/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-11/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-12/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-12/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-12/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-10/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-10/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-10/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-5/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-5/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-5/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-7/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-7/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-7/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-14/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-14/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-14/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-16/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-16/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-16/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-13/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-13/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-13/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-1210_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO2-1244-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-1210_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO1-1243-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-1210_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO3-1245-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LPS4018_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO1-1246-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LPS4018_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO3-1248-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LPS4018_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO2-1247-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO5-1263-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO1-1259-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO2-1260-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO3-1261-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO4-1262-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO6-1264-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO7-1265-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO9-1267-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO13-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO16-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO18-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO19-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO12-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO24-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO23-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO14-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO10-1268-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO8-1266-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO11-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO15-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO17-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO20-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO21-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO22-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO30-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO27-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO29-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO26-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO25-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-220WGGE_ANYUNSPECIFIED_ASM-1/S_X_F3LIDO28-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO2-1250-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO1-1249-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO7-1255-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO10-1258-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO5-1253-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO6-1254-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO4-1252-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO3-1251-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO9-1257-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "MO-229W3030D-1_4000_ASM-1/S_X_F3LIDO8-1256-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-18/S_X_F3LIDO3-1242-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-18/S_X_F3LIDO1-1240-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "RESC-0805_ANYUNSPECIFIED_ASM-18/S_X_F3LIDO2-1241-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__5": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__6": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "THIGH_RH_MIR-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "WRIST_RH_1_MIR-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "FOOT_GRIP-1__4": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LEG_KNEE_RH_MIR-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_COVER_MIR-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "SHOULDER_PIN_MIR-1__2": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__7": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NUT_M3_1_ASM__8": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "ARDUINOUNODETAILED-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-3__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_5MM_RED-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "BODY_REMODEL-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "HC-SR04-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "BODY_REMODEL_LID-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "STRIPBOARD-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "HC-SR04-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "LED_5MM_RED-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-2__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "NOSE_REMODEL-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "Container_axel-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-7__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "Guard_Shell-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-5__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-4__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "Container-1__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-6__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
  "M3X12_PHILIPS_SCREW-8__1": { direction: [0, 0, 0], distance: 0, rotationAmount: 0 },
};

let heroModelScene = null;
let heroModelCamera = null;
let heroModelRenderer = null;
let heroModelRig = null;
let heroModelRoot = null;
let heroModelExplodeRoot = null;
let heroModelExplodeParts = [];
let heroModelAnimFrame = null;
let heroModelSize = new THREE.Vector3(1, 1, 1);
let heroModelMaxDim = 1;
let heroModelScrollTarget = 0;
let heroModelScrollCurrent = 0;
let heroModelOrbitAngle = HERO_MODEL_MOTION.orbitStartAngle;
let heroModelLoadedAsset = "";
const heroMotionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const heroModelTempQuat = new THREE.Quaternion();

function setHeroModelStatus(message) {
  const wrap = document.getElementById("heroModelViewer");
  if (!wrap) return;

  let status = wrap.querySelector(".hero-model-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "hero-model-status";
    wrap.appendChild(status);
  }

  status.textContent = message;
}

function getHeroModelPlaybackTarget() {
  // This lets you test the model without scrolling.
  switch (HERO_MODEL_PLAYBACK.mode) {
    case "exploded":
      return 1;
    case "imploded":
      return 0;
    case "manual":
      return THREE.MathUtils.clamp(HERO_MODEL_PLAYBACK.manualProgress, 0, 1);
    default:
      return heroModelScrollTarget;
  }
}

function clearHeroModelStatus() {
  const wrap = document.getElementById("heroModelViewer");
  if (!wrap) return;

  const status = wrap.querySelector(".hero-model-status");
  if (status) status.remove();
}

function styleHeroModel(root) {
  // Applies the look controls above to every mesh in the loaded model.
  root.traverse((child) => {
    if (!child.isMesh) return;

    child.frustumCulled = false;

    if (child.isSkinnedMesh) {
      child.bindMode = "attached";
      child.normalizeSkinWeights();
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const nextMaterials = materials.map((mat) => {
      if (!mat) return mat;

      const next = mat.clone();
      if ("color" in next && HERO_MODEL_LOOK.color != null) next.color = new THREE.Color(HERO_MODEL_LOOK.color);
      if ("emissive" in next && HERO_MODEL_LOOK.emissive != null) next.emissive = new THREE.Color(HERO_MODEL_LOOK.emissive);
      if ("emissiveIntensity" in next && HERO_MODEL_LOOK.emissiveIntensity != null) next.emissiveIntensity = HERO_MODEL_LOOK.emissiveIntensity;
      if ("metalness" in next && HERO_MODEL_LOOK.metalness != null) next.metalness = HERO_MODEL_LOOK.metalness;
      if ("roughness" in next && HERO_MODEL_LOOK.roughness != null) next.roughness = HERO_MODEL_LOOK.roughness;
      if ("transparent" in next) next.transparent = HERO_MODEL_LOOK.transparent || HERO_MODEL_LOOK.opacity < 1;
      if ("opacity" in next && HERO_MODEL_LOOK.opacity != null) next.opacity = HERO_MODEL_LOOK.opacity;
      if ("side" in next) next.side = HERO_MODEL_LOOK.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      if ("skinning" in next) next.skinning = child.isSkinnedMesh;
      next.needsUpdate = true;
      return next;
    });

    child.material = Array.isArray(child.material) ? nextMaterials : nextMaterials[0];
  });
}

function hasRenderableDescendants(node) {
  let hasRenderable = false;

  node.traverse((child) => {
    if (child.isMesh) {
      hasRenderable = true;
    }
  });

  return hasRenderable;
}

function findHeroExplodeRoot(root) {
  let current = root;

  while (
    current &&
    current.children.length === 1 &&
    !current.children[0].isMesh &&
    hasRenderableDescendants(current.children[0])
  ) {
    current = current.children[0];
  }

  const renderableChildren = current.children.filter(hasRenderableDescendants);
  if (renderableChildren.length > 1) {
    return current;
  }

  for (const child of current.children) {
    if (child.isMesh || !hasRenderableDescendants(child)) continue;

    const nestedRenderableChildren = child.children.filter(hasRenderableDescendants);
    if (nestedRenderableChildren.length > 1) {
      return child;
    }
  }

  return current;
}

function collectHeroExplodeCandidates(node, candidates, seen) {
  if (!node || !hasRenderableDescendants(node)) return;

  if (node.isMesh) {
    if (!seen.has(node.uuid)) {
      seen.add(node.uuid);
      candidates.push(node);
    }
    return;
  }

  const directMeshes = node.children.filter((child) => child.isMesh);
  const nestedGroups = node.children.filter((child) => !child.isMesh && hasRenderableDescendants(child));

  if (nestedGroups.length === 0) {
    const targets = directMeshes.length <= 1 ? [node] : directMeshes;
    targets.forEach((target) => {
      if (!seen.has(target.uuid)) {
        seen.add(target.uuid);
        candidates.push(target);
      }
    });
    return;
  }

  directMeshes.forEach((mesh) => {
    if (!seen.has(mesh.uuid)) {
      seen.add(mesh.uuid);
      candidates.push(mesh);
    }
  });

  nestedGroups.forEach((group) => {
    collectHeroExplodeCandidates(group, candidates, seen);
  });
}

function getHeroExplodePartId(nodeName, nameCounts) {
  // Creates stable IDs like "NOSE_REMODEL-1__1" and "NOSE_REMODEL-1__2"
  // so duplicate part names can still be edited individually.
  const safeName = (nodeName || "Unnamed Part").trim() || "Unnamed Part";
  nameCounts[safeName] = (nameCounts[safeName] || 0) + 1;
  return safeName + "__" + nameCounts[safeName];
}

function getHeroExplodeRule(nodeName, partId) {
  // Exact per-part rules are the source of truth now.
  const exactRule = HERO_EXPLODE_PART_RULES[partId] || HERO_EXPLODE_PART_RULES[nodeName];
  if (exactRule && Object.keys(exactRule).length) return exactRule;
  return null;
}

function isHeroExplodeRuleNeutral(rule) {
  if (!rule) return false;

  const direction = Array.isArray(rule.direction) ? rule.direction : [0, 0, 0];
  const directionMagnitude = Math.abs(direction[0] || 0) + Math.abs(direction[1] || 0) + Math.abs(direction[2] || 0);
  const distance = Math.abs(rule.distance || 0);
  const rotationAmount = Math.abs(rule.rotationAmount || 0);

  return directionMagnitude < 1e-6 && distance < 1e-6 && rotationAmount < 1e-6;
}

function buildHeroExplodeParts(root) {
  // Builds the editable explosion metadata for every visible leaf part.
  heroModelExplodeParts = [];
  heroModelExplodeRoot = findHeroExplodeRoot(root);

  const candidates = [];
  const seen = new Set();

  heroModelExplodeRoot.children
    .filter(hasRenderableDescendants)
    .forEach((child) => collectHeroExplodeCandidates(child, candidates, seen));

  if (candidates.length <= 1) {
    console.info("Hero model loaded without separable assembly parts:", heroModelLoadedAsset);
    return;
  }

  const assemblyCenterWorld = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const partNameCounts = Object.create(null);

  candidates.forEach((node, index) => {
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;

    const partId = getHeroExplodePartId(node.name || "", partNameCounts);
    const rule = getHeroExplodeRule(node.name || "", partId);
    const partCenterWorld = box.getCenter(new THREE.Vector3());
    const partSize = box.getSize(new THREE.Vector3());

    // Exact zeroed rules are treated as a hard lock for that part.
    // This makes "direction: [0,0,0], distance: 0, rotationAmount: 0"
    // a reliable neutral starting point while you tune parts individually.
    if (isHeroExplodeRuleNeutral(rule)) {
      heroModelExplodeParts.push({
        node,
        partId,
        partName: node.name || "Unnamed Part",
        restPosition: node.position.clone(),
        restQuaternion: node.quaternion.clone(),
        explodeOffset: new THREE.Vector3(0, 0, 0),
        rotationAxis: new THREE.Vector3(0, 1, 0),
        rotationAmount: 0
      });
      return;
    }

    // A non-zero custom direction wins.
    // Missing direction, or [0, 0, 0], means "use the automatic assembly-center direction".
    const autoDirectionWorld = partCenterWorld.clone().sub(assemblyCenterWorld);
    const directionWorld = autoDirectionWorld.clone();

    if (rule?.direction) {
      const customDirection = new THREE.Vector3(
        rule.direction[0] || 0,
        rule.direction[1] || 0,
        rule.direction[2] || 0
      );

      if (customDirection.lengthSq() >= 1e-6) {
        directionWorld.copy(customDirection);
      }
    }

    if (directionWorld.lengthSq() < 1e-6) {
      const angle = (index / Math.max(candidates.length, 1)) * Math.PI * 2;
      directionWorld.set(
        Math.cos(angle),
        ((index % 3) - 1) * HERO_EXPLODE_CONFIG.fallbackVerticalStep,
        Math.sin(angle)
      );
    }

    directionWorld.normalize();

    const sizeRatio = partSize.length() / Math.max(heroModelMaxDim, 1);
    const spread = heroModelMaxDim * (
      rule?.distance ??
      (HERO_EXPLODE_CONFIG.defaultDistanceBase + Math.min(sizeRatio, HERO_EXPLODE_CONFIG.defaultDistanceCap))
    );
    const parent = node.parent || heroModelExplodeRoot;
    const localStart = parent.worldToLocal(partCenterWorld.clone());
    const localEnd = parent.worldToLocal(
      partCenterWorld.clone().add(directionWorld.clone().multiplyScalar(spread))
    );
    const localDirection = localEnd.clone().sub(localStart);

    if (localDirection.lengthSq() < 1e-6) {
      localDirection.set(directionWorld.x, directionWorld.y, directionWorld.z);
    }

    localDirection.normalize();
    const rotationAxis = rule?.rotationAxis
      ? new THREE.Vector3(rule.rotationAxis[0], rule.rotationAxis[1], rule.rotationAxis[2]).normalize()
      : new THREE.Vector3(
          localDirection.z || 0.25,
          0.4 + (index % 5) * 0.08,
          -localDirection.x || 0.25
        ).normalize();

    heroModelExplodeParts.push({
      node,
      partId,
      partName: node.name || "Unnamed Part",
      restPosition: node.position.clone(),
      restQuaternion: node.quaternion.clone(),
      explodeOffset: localEnd.sub(localStart),
      rotationAxis,
      rotationAmount: rule?.rotationAmount ?? (
        HERO_EXPLODE_CONFIG.defaultRotationBase + (index % 4) * HERO_EXPLODE_CONFIG.defaultRotationStep
      )
    });
  });

  if (HERO_MODEL_DEBUG.logExplodePartIdsOnLoad) {
    // Browser console helper for creating exact per-part overrides.
    console.groupCollapsed("Hero explode part IDs");
    console.table(heroModelExplodeParts.map((part) => ({
      id: part.partId,
      name: part.partName
    })));
    console.groupEnd();
  }
}

function applyHeroModelExplosion(progress) {
  // Turns section scroll progress into explosion progress.
  const explodePhase = THREE.MathUtils.smootherstep(
    progress,
    HERO_EXPLODE_CONFIG.start,
    HERO_EXPLODE_CONFIG.end
  );
  const explodeProgress = explodePhase;

  heroModelExplodeParts.forEach((part) => {
    const liveRule = getHeroExplodeRule(part.partName, part.partId);
    const ruleIsNeutral = isHeroExplodeRuleNeutral(liveRule);
    const offset = ruleIsNeutral ? new THREE.Vector3(0, 0, 0) : part.explodeOffset.clone();

    // Global axis multipliers let you flip or exaggerate the entire explosion.
    // x: right/left, y: up/down, z: forward/backward
    offset.set(
      offset.x * HERO_EXPLODE_CONFIG.axis.x,
      offset.y * HERO_EXPLODE_CONFIG.axis.y,
      offset.z * HERO_EXPLODE_CONFIG.axis.z
    );

    part.node.position
      .copy(part.restPosition)
      .addScaledVector(offset, explodeProgress);

    heroModelTempQuat.setFromAxisAngle(
      part.rotationAxis,
      (ruleIsNeutral ? 0 : part.rotationAmount) * explodeProgress
    );

    part.node.quaternion
      .copy(part.restQuaternion)
      .multiply(heroModelTempQuat);
  });

  return explodeProgress;
}


function updateHeroModelScrollProgress() {
  // Scroll does nothing until the standalone model section is actually on screen.
  const section = document.querySelector(".argos-model-section");
  if (!section) return;

  const rect = section.getBoundingClientRect();
  const triggerY = window.innerHeight * HERO_MODEL_PLAYBACK.triggerLine;

  if (rect.bottom <= 0 || rect.top > triggerY) {
    heroModelScrollTarget = 0;
    return;
  }

  const range = Math.max(rect.height - triggerY + window.innerHeight * 0.55, 1);
  const traveled = triggerY - rect.top;
  heroModelScrollTarget = THREE.MathUtils.clamp(traveled / range, 0, 1);
}

function resizeHeroModelViewer() {
  const wrap = document.getElementById("heroModelViewer");
  if (!wrap || !heroModelRenderer || !heroModelCamera) return;

  const width = wrap.clientWidth || 640;
  const height = wrap.clientHeight || 640;

  heroModelCamera.aspect = width / height;
  heroModelCamera.updateProjectionMatrix();
  heroModelRenderer.setSize(width, height);
}

function loadHeroModel() {
  if (!heroModelScene) return;

  setHeroModelStatus("Loading " + HERO_MODEL_CONFIG.name);

  const loader = new THREE.GLTFLoader();
  const dracoLoader = new THREE.DRACOLoader();
  dracoLoader.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/");
  loader.setDRACOLoader(dracoLoader);

  const tryLoadAsset = (assetIndex) => {
    const assetPath = HERO_MODEL_CONFIG.assetCandidates[assetIndex];

    if (!assetPath) {
      console.error("Hero model failed to load all asset candidates");
      setHeroModelStatus(HERO_MODEL_CONFIG.name + " model unavailable");
      return;
    }

    loader.load(
      assetPath,
      function (gltf) {
        heroModelLoadedAsset = assetPath;
        clearHeroModelStatus();

        if (heroModelRig) {
          heroModelScene.remove(heroModelRig);
        }

        heroModelRig = new THREE.Group();
        heroModelRoot = gltf.scene;
        heroModelExplodeParts = [];

        styleHeroModel(heroModelRoot);

        heroModelRoot.scale.set(
          HERO_MODEL_TRANSFORM.scale[0],
          HERO_MODEL_TRANSFORM.scale[1],
          HERO_MODEL_TRANSFORM.scale[2]
        );
        heroModelRoot.position.set(0, 0, 0);
        heroModelRoot.rotation.set(0, 0, 0);

        const box = new THREE.Box3().setFromObject(heroModelRoot);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        heroModelSize.copy(size);
        heroModelMaxDim = Math.max(size.x, size.y, size.z) || 1;

        heroModelRoot.position.set(-center.x, -center.y, -center.z);
        heroModelRig.position.set(
          HERO_MODEL_TRANSFORM.position[0],
          HERO_MODEL_TRANSFORM.position[1],
          HERO_MODEL_TRANSFORM.position[2]
        );
        heroModelRig.rotation.set(
          HERO_MODEL_TRANSFORM.rotation[0],
          HERO_MODEL_TRANSFORM.rotation[1],
          HERO_MODEL_TRANSFORM.rotation[2]
        );

        heroModelRig.add(heroModelRoot);
        heroModelScene.add(heroModelRig);
        heroModelRig.updateWorldMatrix(true, true);
        buildHeroExplodeParts(heroModelRoot);
        applyHeroModelExplosion(0);
        resizeHeroModelViewer();
        updateHeroModelScrollProgress();
      },
      undefined,
      function (error) {
        if (assetIndex < HERO_MODEL_CONFIG.assetCandidates.length - 1) {
          console.warn("Hero model asset unavailable, trying fallback:", assetPath);
          tryLoadAsset(assetIndex + 1);
          return;
        }

        console.error("Hero model failed to load:", error);
        setHeroModelStatus(HERO_MODEL_CONFIG.name + " model unavailable");
      }
    );
  };

  tryLoadAsset(0);
}

function animateHeroModelViewer() {
  if (!heroModelRenderer || !heroModelScene || !heroModelCamera) return;

  function loop(now) {
    heroModelAnimFrame = requestAnimationFrame(loop);
    updateHeroModelScrollProgress();

    const reducedMotion = !!heroMotionQuery?.matches;
    const blend = reducedMotion ? HERO_MODEL_MOTION.reducedMotionBlend : HERO_MODEL_MOTION.scrollBlend;
    const targetProgress = getHeroModelPlaybackTarget();
    heroModelScrollCurrent += (targetProgress - heroModelScrollCurrent) * blend;

    if (heroModelRig) {
      // explodeProgress is the one number that drives the visible separation.
      const explodeProgress = applyHeroModelExplosion(heroModelScrollCurrent);
      const depthPull = explodeProgress * heroModelMaxDim * HERO_MODEL_MOTION.depthPullOnExplode;
      const explodeLift = explodeProgress * heroModelMaxDim * HERO_MODEL_MOTION.liftOnExplode;
      const zoomOut =
        explodeProgress * HERO_MODEL_CAMERA.radiusExplodeBoost +
        heroModelScrollCurrent * HERO_MODEL_CAMERA.radiusScrollBoost;

      heroModelOrbitAngle += (
        (HERO_MODEL_MOTION.orbitStartAngle + heroModelScrollCurrent * HERO_MODEL_MOTION.orbitTurnPerScroll) -
        heroModelOrbitAngle
      ) * HERO_MODEL_MOTION.orbitLerp;

      heroModelRig.rotation.x = HERO_MODEL_TRANSFORM.rotation[0] + heroModelScrollCurrent * HERO_MODEL_MOTION.rotateXPerScroll;
      heroModelRig.rotation.y = HERO_MODEL_TRANSFORM.rotation[1] + heroModelScrollCurrent * HERO_MODEL_MOTION.rotateYPerScroll;
      heroModelRig.rotation.z = HERO_MODEL_TRANSFORM.rotation[2] + heroModelScrollCurrent * HERO_MODEL_MOTION.rotateZPerScroll;

      heroModelRig.position.x = HERO_MODEL_TRANSFORM.position[0];
      heroModelRig.position.y =
        HERO_MODEL_TRANSFORM.position[1] +
        heroModelScrollCurrent * heroModelMaxDim * HERO_MODEL_MOTION.moveYPerScroll -
        explodeLift;
      heroModelRig.position.z = HERO_MODEL_TRANSFORM.position[2] - depthPull;
      heroModelRig.scale.setScalar(1 - explodeProgress * HERO_MODEL_MOTION.scaleDownOnExplode);

      const radius = heroModelMaxDim * (HERO_MODEL_CAMERA.radiusBase + zoomOut);
      heroModelCamera.position.x = heroModelRig.position.x + Math.cos(heroModelOrbitAngle) * radius;
      heroModelCamera.position.z = heroModelRig.position.z + Math.sin(heroModelOrbitAngle) * radius;
      heroModelCamera.position.y =
        heroModelRig.position.y +
        heroModelSize.y * (
          HERO_MODEL_CAMERA.heightBaseFactor +
          heroModelScrollCurrent * HERO_MODEL_CAMERA.heightScrollFactor +
          explodeProgress * HERO_MODEL_CAMERA.heightExplodeFactor
        );

      heroModelCamera.lookAt(
        heroModelRig.position.x,
        heroModelRig.position.y + heroModelSize.y * HERO_MODEL_CAMERA.lookAtYOffset,
        heroModelRig.position.z
      );
    }

    heroModelRenderer.render(heroModelScene, heroModelCamera);
  }

  loop(0);
}

function initHeroModelViewer() {
  const wrap = document.getElementById("heroModelViewer");
  if (!wrap || !window.THREE) return;

  if (heroModelRenderer) {
    resizeHeroModelViewer();
    return;
  }

  setHeroModelStatus("Loading " + HERO_MODEL_CONFIG.name);

  const width = wrap.clientWidth || 640;
  const height = wrap.clientHeight || 640;

  // Camera setup is controlled by HERO_MODEL_CAMERA above.
  heroModelScene = new THREE.Scene();
  heroModelCamera = new THREE.PerspectiveCamera(
    HERO_MODEL_CAMERA.fov,
    width / height,
    HERO_MODEL_CAMERA.near,
    HERO_MODEL_CAMERA.far
  );
  heroModelCamera.position.set(
    HERO_MODEL_CAMERA.position[0],
    HERO_MODEL_CAMERA.position[1],
    HERO_MODEL_CAMERA.position[2]
  );

  heroModelRenderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true
  });
  heroModelRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  heroModelRenderer.setSize(width, height);
  heroModelRenderer.outputEncoding = THREE.sRGBEncoding;
  heroModelRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  heroModelRenderer.toneMappingExposure = HERO_MODEL_LOOK.toneMappingExposure;
  heroModelRenderer.domElement.style.width = "100%";
  heroModelRenderer.domElement.style.height = "100%";
  heroModelRenderer.domElement.style.display = "block";
  heroModelRenderer.domElement.style.pointerEvents = "none";
  wrap.appendChild(heroModelRenderer.domElement);

  // Lighting setup is controlled by HERO_MODEL_LIGHTING above.
  heroModelScene.add(new THREE.AmbientLight(
    HERO_MODEL_LIGHTING.ambient.color,
    HERO_MODEL_LIGHTING.ambient.intensity
  ));

  const keyLight = new THREE.DirectionalLight(
    HERO_MODEL_LIGHTING.key.color,
    HERO_MODEL_LIGHTING.key.intensity
  );
  keyLight.position.set(
    HERO_MODEL_LIGHTING.key.position[0],
    HERO_MODEL_LIGHTING.key.position[1],
    HERO_MODEL_LIGHTING.key.position[2]
  );
  heroModelScene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(
    HERO_MODEL_LIGHTING.rim.color,
    HERO_MODEL_LIGHTING.rim.intensity
  );
  rimLight.position.set(
    HERO_MODEL_LIGHTING.rim.position[0],
    HERO_MODEL_LIGHTING.rim.position[1],
    HERO_MODEL_LIGHTING.rim.position[2]
  );
  heroModelScene.add(rimLight);

  const fillLight = new THREE.HemisphereLight(
    HERO_MODEL_LIGHTING.fill.skyColor,
    HERO_MODEL_LIGHTING.fill.groundColor,
    HERO_MODEL_LIGHTING.fill.intensity
  );
  heroModelScene.add(fillLight);

  updateHeroModelScrollProgress();
  loadHeroModel();
  animateHeroModelViewer();

  if (!window.__heroModelEventsBound) {
    window.__heroModelEventsBound = true;
    window.addEventListener("resize", resizeHeroModelViewer);
    window.addEventListener("scroll", updateHeroModelScrollProgress, { passive: true });
  }
}

/* ============================================================
   Footer button functions
   ============================================================ */
function showPage(id){
  document.querySelectorAll(".page").forEach(page => {
    page.classList.remove("active");
  });

  document.getElementById(id).classList.add("active");
  syncFloatingFooter();
}



function home() {
  showPage("home");

  document.getElementById("robot").style.display = "none";
  document.getElementById("setup").style.display = "flex";
  document.getElementById("setup-footer").style.display = "flex";
  setStep(0);
}

function data() {
  showPage("content");
}

function settings() {
  showPage("settings");
}

function openlogin() {
  setStep(0);
  showPage("user-screen");

  document.getElementById("robot").style.display = "none";
  document.getElementById("setup").style.display = "flex";
  document.getElementById("setup-footer").style.display = "flex";
}

function isSiteFooterNearViewport() {
  const siteFooter = document.querySelector(".guard-footer");
  if (!siteFooter) return false;

  const rect = siteFooter.getBoundingClientRect();
  return rect.bottom > 0 && rect.top <= (window.innerHeight - 96);
}

function syncFloatingFooter() {
  const footerNav = document.getElementById("footerbuttons");
  const guardian = document.getElementById("guardiancontent");
  const footerPagesWrap = document.getElementById("footer-pages");
  const activePage = document.querySelector(".page.active");

  if (!footerNav) return;

  const guardianVisible = !!(guardian && guardian.classList.contains("active"));
  const footerPagesOpen = !!(footerPagesWrap && getComputedStyle(footerPagesWrap).display !== "none");
  const appPageVisible = !!(activePage && activePage.id !== "user-screen");
  const shouldShow = guardianVisible && appPageVisible && !footerPagesOpen && !isSiteFooterNearViewport();

  footerNav.classList.toggle("is-visible", shouldShow);
}

window.addEventListener("scroll", syncFloatingFooter, { passive: true });
window.addEventListener("resize", syncFloatingFooter);
syncFloatingFooter();

/* ============================================================
   NEVER-SILENT DEBUG HELPERS
   ============================================================ */
function dbg(msg){
  const el = document.getElementById("analysis-debug");
  if (el) el.textContent = msg || "";
}
window.addEventListener("error", (e) => dbg("JS error: " + (e.message || "unknown")));
window.addEventListener("unhandledrejection", (e) => dbg("Promise error: " + (e.reason?.message || e.reason || "unknown")));

/* ============================================================
   SESSION MANAGEMENT
   ============================================================ */
/* ============================================================
   Real Dexcom sessions are stored safely on the Worker.
   The browser only keeps:
   - a tiny demo-mode flag in sessionStorage for local developer mode
   - an in-memory boolean that says whether a secure server session exists
   The real authenticated session is an HttpOnly cookie, which page JavaScript
   cannot read back out.
   ============================================================ */
function isDemoMode() {
  try {
    return sessionStorage.getItem(DEMO_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function setDemoMode(enabled) {
  try {
    if (enabled) {
      sessionStorage.setItem(DEMO_MODE_KEY, "1");
    } else {
      sessionStorage.removeItem(DEMO_MODE_KEY);
    }
  } catch {}
}

function getSessionToken() {
  if (isDemoMode()) {
    return DEMO_TOKEN_PREFIX + "local-demo";
  }

  return hasServerSession ? "server-session" : "";
}

function setSessionToken(t) {
  const demo = !!t && t.startsWith(DEMO_TOKEN_PREFIX);
  setDemoMode(demo);
  hasServerSession = !!t && !demo;
}

function authHeaders() {
  // Real authenticated requests now use the secure session cookie automatically.
  // This helper stays in place so older fetch code can keep calling it.
  return {};
}

async function refreshSessionState() {
  if (isDemoMode()) {
    hasServerSession = false;
    setCurrentDeviceId("demo-device");
    setClaimCardVisible(false, { state: "" });
    return { ok: true, logged_in: true, demo: true };
  }

  try {
    const res = await fetch("/session", {
      cache: "no-store",
      credentials: "same-origin"
    });
    const data = await res.json().catch(() => ({}));
    hasServerSession = !!data.logged_in;
    if (data.device_id) {
      setCurrentDeviceId(data.device_id);
      clearPendingClaimCode();
      setClaimCardVisible(false, { state: "" });
    } else {
      setCurrentDeviceId("");
      if (data.logged_in) {
        setClaimCardVisible(true, {
          help: "Guardian is ready for pairing. Enter the claim code shown after Bluetooth or GUARD-SETUP setup.",
          state: ""
        });
      }
    }
    return {
      ok: !!data.ok,
      logged_in: !!data.logged_in,
      device_id: data.device_id || "",
      device_claim_required: !!data.device_claim_required,
      trusted_users_count: data.trusted_users_count,
      demo: false
    };
  } catch {
    hasServerSession = false;
    setCurrentDeviceId("");
    return { ok: false, logged_in: false, demo: false };
  }
}

function openRobotView() {
  document.getElementById("setup").style.display = "none";
  document.getElementById("setup-footer").style.display = "none";
  document.getElementById("robot").style.display = "flex";

  setTimeout(() => {
    initRobotViewer();
    resizeRobotViewer();
    initModelWheel();
    centerModelWheelOn(currentRobotAnimal, false);
    updateModelWheelSelection();
  }, 50);
}

/* ============================================================
   Step setter that also updates the UI to show which step is active and changes the "Next" button text on the last step
   ============================================================ */
function setStep(i) {
  step = Math.max(0, Math.min(i, LAST_STEP));

  steps.forEach((panel, idx) => panel.classList.toggle("active", idx === step));

  dots.forEach((d, idx) => {
    d.classList.toggle("active", idx === step);
    d.classList.toggle("done", idx < step);
  });

  nextBtn.textContent = (step === LAST_STEP) ? "Continue to Robot" : "Next";

  if (step === 0) {
    backBtn.style.background = "rgba(200,200,200,.50)";
    backBtn.style.color = "rgba(16,25,21,.45)";
    backBtn.style.border = "1px solid rgba(120,130,125,.20)";
    backBtn.disabled = true;
  } else {
    backBtn.style.background = "linear-gradient(180deg, rgba(9,176,44,1) 0%, rgba(8,155,39,1) 100%)";
    backBtn.style.color = "white";
    backBtn.style.border = "none";
    backBtn.disabled = false;
  }
}

function info() {
  home();
}

/* ============================================================
   Change setup screen step by 1 or if on last step, open login screen
   ============================================================ */
function backStep() {
  if (step > 0) {
    setStep(step - 1);
  }
}

function nextStep() {
  if (step === LAST_STEP) {
    openRobotView();
    setStep(0);
    return;
  }
  setStep(step + 1);
}

/* ============================================================
   Hide setup screen and show login screen
   ============================================================ */

/* ============================================================
   CHART GLOBALS / CONSTANTS
   ============================================================ */

/* ============================================================
   SMALL UI HELPERS
   ============================================================ */
function setEmpty(isEmpty) {
  /*if chart is empty, check if element exists and if so hide it */
  const el = document.getElementById("chart-empty");
  if (el) el.style.display = isEmpty ? "flex" : "none";
}

/* ============================================================
   Just displays the low and high range values in the chart header
   ============================================================ */
function setThresholdLabels() {
  const el = document.getElementById("threshold-labels");
  if (el) el.textContent = "Low " + RANGE_LOW + " • High " + RANGE_HIGH;
}

/* ============================================================
   ✅ ANALYSIS THAT NEVER GOES BLANK
   ============================================================ */
function clamp(v, lo, hi) {
  /*keeps numbers in range annd if out of range returns high or low*/
  return Math.max(lo, Math.min(hi, v));
}

/* ============================================================
   average change of window
   ============================================================ */
function median(arr){
  /*makes a copy of the array so that the original is not modified*/
  const a = arr.slice().sort((x,y)=>x-y);
  /*give the median value*/
  return a[Math.floor(a.length/2)];
}

/* ============================================================
   average change of window
   ============================================================ */
function normalizeDexcomPoints(points, {
  bucketMin = 5,
  minGlucose = 40,
  maxGlucose = 400
} = {}) {
  const bucketMs = bucketMin * 60 * 1000;

  const raw = (points || [])
    /*converts dexcom data into readable format*/
    .map(p => ({ x: Number(p.ts) * 1000, y: Number(p.glucose) }))
    /*gets rid of invalid points*/
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
    /*keeps valid points within the glucose range (I think this is pointless becuase dexcom already caps at 40 and 400 anyway)*/
    .map(p => ({ x: p.x, y: Math.max(minGlucose, Math.min(maxGlucose, p.y)) }))
    /*orders the time idk*/
    .sort((a,b) => a.x - b.x);

  if (!raw.length) return [];

  const bucketMap = new Map();
  for (const p of raw) {
    /*rounds the time, also i think pointless because dexcom polls every 5 minutes, I guess if the 5 minute intervals are already not starting at 0:00 then it does it*/
    const bucketKey = Math.round(p.x / bucketMs) * bucketMs;
    const existing = bucketMap.get(bucketKey);
    if (!existing || p.x >= existing._rawX) {
      bucketMap.set(bucketKey, { x: bucketKey, y: p.y, _rawX: p.x });
    }
  }
  /*has a rounded time, glucose value, and raw time array*/
  return Array.from(bucketMap.values())
    /*sorts it one more time*/
    .sort((a,b) => a.x - b.x)
    .map(p => ({ x: p.x, y: p.y }));
}

/* ============================================================
   average change of window
   ============================================================ */
function avgChangeWindow(points, windowMin = 60) {
  if (!points || points.length < 2) return { ok:false, reason:"No data" };
  /* if there arnt points or less than 2 then not enough data*/
  const last = points[points.length - 1];
  /*most recent glucose point*/
  const tNow = last.x;
  /*most recent time value*/
  const tTarget = tNow - windowMin * 60000;
  /*most recent time value - look back window for average change analysis in miliseconds*/
  /*start time for average change calculation*/

  // Find earliest point >= tTarget (or fall back to earliest available)
  let i = 0;
  while (i < points.length && points[i].x < tTarget) i++;
  /*the point index is less than its lentgh of indexes and its actual value of the time is in the lookout window*/

  let yStart, tStart;
  /*in the window (0< i < length of index)*/
  if (i > 0 && i < points.length) {
    const pA = points[i - 1];
    /*point right before point*/
    const pB = points[i];
    /*the point*/
    const dt = pB.x - pA.x;
    /*difference of time of point and time of point before*/
    /*delta time, time differencd*/
    if (dt <= 0) return { ok:false, reason:"Bad timestamps" };
    /*change in time cant be zero or negetive duh so error*/
    const frac = (tTarget - pA.x) / dt;
    /*time of target - time of next point all over change in time between point and next point*/
    yStart = pA.y + frac * (pB.y - pA.y);
    tStart = tTarget;
  } else {
    // Not enough history: use first point
    const first = points[0];
    yStart = first.y;
    tStart = first.x;
  }

  const yNow = last.y;
  const delta = yNow - yStart;
  const minutes = Math.max(1e-6, (tNow - tStart) / 60000);
  const ratePerHr = (delta / minutes) * 60;

  return { ok:true, delta, ratePerHr, minutesUsed: minutes };
}

/* ============================================================
   Update data Analysis card
   ============================================================ */

function updateAnalysisUI(normalizedPts) {
  const avgEl = document.getElementById("avgchg");
  const urgEl = document.getElementById("Urgency");

  if (!avgEl || !urgEl) {
    dbg("Missing analysis elements (#avgchg or #Urgency).");
    return;
  }

  if (!normalizedPts || normalizedPts.length < 2) {
    const debugText =
      (document.getElementById("analysis-debug")?.textContent || "").toLowerCase();

    if (debugText.includes("no active sensor") || debugText.includes("no dexcom")) {
      setAnalysisState("no_sensor");
    } else {
      setAnalysisState("no_data");
    }
    return;
  }

  setAnalysisState("live");

  const r = avgChangeWindow(normalizedPts, 60);

  if (!r.ok) {
    avgEl.textContent = "Average change (1h): —";
    urgEl.textContent = "Urgency: —";
    dbg("Analysis failed: " + (r.reason || "unknown"));
    return;
  }

  const sign = r.delta >= 0 ? "+" : "-";
  const label = r.minutesUsed >= 59.5 ? "1h" : (r.minutesUsed.toFixed(0) + " min");

  avgEl.textContent =
    "Average change (" + label + "): " + sign + r.delta.toFixed(0) + " mg/dL";

  let u = "Low";
  if (r.ratePerHr <= -60) u = "High";
  else if (r.ratePerHr <= -30) u = "Medium";

  urgEl.textContent = "Urgency: " + u;

  dbg("Analysis OK. Points=" + normalizedPts.length + ". WindowUsed=" + r.minutesUsed.toFixed(1) + " min.");
}
/* ============================================================
   Low and High RANGE lines draw
   ============================================================ */
const rangeBandsPlugin = {
  id: "rangeBands",
  beforeDraw(c) {
    const { ctx, chartArea, scales } = c;
    if (!chartArea) return;

    const y = scales.y;
    const left = chartArea.left, right = chartArea.right;
    const top = chartArea.top, bottom = chartArea.bottom;

    const yLow = y.getPixelForValue(RANGE_LOW);
    const yHigh = y.getPixelForValue(RANGE_HIGH);

    ctx.save();
    ctx.fillStyle = "rgba(255,0,0,.06)";
    ctx.fillRect(left, top, right - left, Math.max(0, yHigh - top));

    ctx.fillStyle = "rgba(9,176,44,.09)";
    ctx.fillRect(left, Math.min(yHigh, yLow), right - left, Math.abs(yLow - yHigh));

    ctx.fillStyle = "rgba(255,200,0,.10)";
    ctx.fillRect(left, Math.min(bottom, yLow), right - left, Math.max(0, bottom - yLow));
    ctx.restore();
  }
};

/* ============================================================
   Draw Forecast start bound dashed line
   ============================================================ */
const forecastMarkerPlugin = {
  id: "forecastMarker",
  afterDatasetsDraw(chart) {
    if (!Number.isFinite(FORECAST_X_MS) || !Number.isFinite(FORECAST_Y)) return;

    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;

    const xScale = scales.x;
    const yScale = scales.y;

    const xPx = xScale.getPixelForValue(FORECAST_X_MS);
    const yPx = yScale.getPixelForValue(FORECAST_Y);

    if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) return;
    if (xPx < chartArea.left || xPx > chartArea.right) return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(16,25,21,.45)";

    ctx.beginPath();
    ctx.moveTo(xPx, chartArea.top);
    ctx.lineTo(xPx, chartArea.bottom);
    ctx.stroke();

    if (yPx >= chartArea.top && yPx <= chartArea.bottom) {
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yPx);
      ctx.lineTo(chartArea.right, yPx);
      ctx.stroke();
    }
    ctx.restore();
  }
};

/* ============================================================
   FORECAST CORE (kept minimal - enough for your chart)
   ============================================================ */
function weightedSlope(points, lookbackMin = 25, tauMin = 8) {
  if (!points || points.length < 4) return 0;

  const last = points[points.length - 1];
  /*last data from dexcom*/
  const lookbackMs = lookbackMin * 60 * 1000;
  /*turns lookback value from minutes to miliseconds (what the code uses for units of time)*/
  const tauMs = tauMin * 60 * 1000;
  /*turns weighted lookback value from minutes to miliseconds (what the code uses for units of time)*/
  const recent = points.filter(p => p.x >= last.x - lookbackMs);
  if (recent.length < 4) return 0;

  const toT = (x) => (x - last.x) / 60000;
  const wOf = (x) => Math.exp(-(last.x - x) / tauMs);

  let Sw=0, St=0, Sy=0;
  for (const p of recent) {
    const w = wOf(p.x);
    const t = toT(p.x);
    Sw += w; St += w*t; Sy += w*p.y;
  }
  const mt = St / Sw;
  const my = Sy / Sw;

  let num=0, den=0;
  for (const p of recent) {
    const w = wOf(p.x);
    const t = toT(p.x) - mt;
    const y = p.y - my;
    num += w * t * y;
    den += w * t * t;
  }

  if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return 0;
  return num / den;
}

/* ============================================================
   estimates acceleration of last 4 points for more recency bias
   ============================================================ */
function estimateAccel(points) {
  if (!points || points.length < 4) return 0;

  const p3 = points[points.length - 4];
  const p2 = points[points.length - 3];
  const p1 = points[points.length - 2];
  const p0 = points[points.length - 1];

  const dt1 = (p0.x - p1.x) / 60000;
  const dt2 = (p1.x - p2.x) / 60000;
  const dt3 = (p2.x - p3.x) / 60000;
  if (!(dt1>0 && dt2>0 && dt3>0)) return 0;

  const s1 = (p0.y - p1.y) / dt1;
  const s2 = (p1.y - p2.y) / dt2;
  const s3 = (p2.y - p3.y) / dt3;

  const a1 = (s1 - s2) / Math.max(1e-6, (dt1+dt2)/2);
  const a2 = (s2 - s3) / Math.max(1e-6, (dt2+dt3)/2);

  return clamp(0.65*a1 + 0.35*a2, -6, 6);
}

/* ============================================================
   How unpredictable your recent data is,
   and returning that as a sigma (standard-deviation-ish) value
   ============================================================ */
function estimateResidualSigma(points, lookbackMin = 30, tauMin = 10) {
  if (!points || points.length < 6) return 12;

  const last = points[points.length - 1];
  const lookbackMs = lookbackMin * 60 * 1000;

  const recent = points.filter(p => p.x >= last.x - lookbackMs);
  if (recent.length < 6) return 12;

  const slope = weightedSlope(recent, lookbackMin, tauMin);
  const lastY = last.y;
  const toT = (x) => (x - last.x) / 60000;

  const residuals = [];
  for (const p of recent) {
    const t = toT(p.x);
    const yhat = lastY + slope * t;
    residuals.push(p.y - yhat);
  }

  const absRes = residuals.map(r => Math.abs(r));
  const med = median(absRes) || 0;
  return clamp(med * 1.35, 6, 28);
}

/* ============================================================
   Build Forecast
   ============================================================ */
function buildCgmForecastWithBands(rawPoints, {
  horizonMin = PRED_HORIZON_MIN,
  stepMin = PRED_STEP_MIN,
  clampMin = 40,
  clampMax = 350,
  processNoisePerMin = 0.65,
  horizonGrowth = 0.22
} = {}) {
  const pts = normalizeDexcomPoints(rawPoints);
  if (pts.length < 4) return { mean: [], lo50: [], hi50: [], lo90: [], hi90: [] };

  const last = pts[pts.length - 1];
  const lastX = last.x;
  const lastY = last.y;

  let slope = clamp(weightedSlope(pts, 25, 8), -8, 8);
  let accel = estimateAccel(pts);
  const sigma0 = estimateResidualSigma(pts, 30, 10);

  const mean = [{ x: lastX, y: lastY }];
  const lo90 = [{ x: lastX, y: lastY }];
  const hi90 = [{ x: lastX, y: lastY }];
  const lo50 = [{ x: lastX, y: lastY }];
  const hi50 = [{ x: lastX, y: lastY }];

  const steps = Math.floor(horizonMin / stepMin);
  const K50 = 0.67;
  const K90 = 1.65;

  for (let i=1; i<=steps; i++) {
    const dt = stepMin;
    const x = lastX + i * dt * 60000;

    const prev = mean[mean.length - 1].y;
    let y = prev + slope*dt + 0.5*accel*dt*dt;
    y = clamp(y, clampMin, clampMax);

    mean.push({ x, y });

    const minutesAhead = i * dt;
    const sigmaH = sigma0 + (horizonGrowth + processNoisePerMin) * Math.sqrt(minutesAhead);

    lo50.push({ x, y: clamp(y - K50*sigmaH, clampMin, clampMax) });
    hi50.push({ x, y: clamp(y + K50*sigmaH, clampMin, clampMax) });
    lo90.push({ x, y: clamp(y - K90*sigmaH, clampMin, clampMax) });
    hi90.push({ x, y: clamp(y + K90*sigmaH, clampMin, clampMax) });

    slope *= 0.92;
    accel *= 0.80;
  }

  return { mean, lo50, hi50, lo90, hi90 };
}

/* ============================================================
   POINTER-CENTERED WHEEL ZOOM (CLAMPED)
   ============================================================ */
let __wheelZoomAttached = false;
function attachPointerWheelZoom() {
  if (!chart || __wheelZoomAttached) return;

  const canvas = chart.canvas;
  if (!canvas) return;

  canvas.addEventListener("wheel", (e) => {
    if (!chart?.chartArea) return;
    e.preventDefault();

    if (!Number.isFinite(NORMAL_MIN_X) || !Number.isFinite(NORMAL_MAX_X)) return;
    const hasNormalY = Number.isFinite(NORMAL_MIN_Y) && Number.isFinite(NORMAL_MAX_Y);

    const area = chart.chartArea;
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;

    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (px < area.left || px > area.right || py < area.top || py > area.bottom) return;

    const xAtPointer = xScale.getValueForPixel(px);
    const yAtPointer = yScale.getValueForPixel(py);

    const curMinX = xScale.min, curMaxX = xScale.max;
    const curMinY = yScale.min, curMaxY = yScale.max;

    const rangeX = (curMaxX - curMinX) || 1;
    const rangeY = (curMaxY - curMinY) || 1;

    const normalRangeX = (NORMAL_MAX_X - NORMAL_MIN_X) || rangeX;
    const normalRangeY = hasNormalY ? ((NORMAL_MAX_Y - NORMAL_MIN_Y) || rangeY) : null;

    const ZOOM_INTENSITY = 0.0018;
    const factor = Math.exp(e.deltaY * ZOOM_INTENSITY);

    const newRangeX = clamp(rangeX * factor, 2 * 60 * 1000, normalRangeX);
    const newRangeY = hasNormalY
      ? clamp(rangeY * factor, 10, normalRangeY)
      : clamp(rangeY * factor, 10, 300);

    const rx = (xAtPointer - curMinX) / rangeX;
    const ry = (yAtPointer - curMinY) / rangeY;

    let newMinX = xAtPointer - rx * newRangeX;
    let newMaxX = newMinX + newRangeX;

    let newMinY = yAtPointer - ry * newRangeY;
    let newMaxY = newMinY + newRangeY;

    const widthX = newMaxX - newMinX;
    newMinX = clamp(newMinX, NORMAL_MIN_X, NORMAL_MAX_X - widthX);
    newMaxX = newMinX + widthX;

    if (hasNormalY) {
      const heightY = newMaxY - newMinY;
      newMinY = clamp(newMinY, NORMAL_MIN_Y, NORMAL_MAX_Y - heightY);
      newMaxY = newMinY + heightY;
    }

    chart.options.scales.x.min = newMinX;
    chart.options.scales.x.max = newMaxX;
    chart.options.scales.y.min = newMinY;
    chart.options.scales.y.max = newMaxY;

    chart.update("none");
  }, { passive: false });

  __wheelZoomAttached = true;
}

/* ============================================================
   Get initial y-axis sizing (helps with reset zoom function)
   ============================================================ */
function captureNormalYBounds() {
  if (!chart?.scales?.y) return;
  const ymin = chart.scales.y.min;
  const ymax = chart.scales.y.max;
  if (Number.isFinite(ymin) && Number.isFinite(ymax) && ymax > ymin) {
    NORMAL_MIN_Y = ymin;
    NORMAL_MAX_Y = ymax;
  }
}

/* ============================================================
   Resets the zoom on graph
   ============================================================ */
function resetZoomToNormal() {
  if (!chart) return;
  if (typeof chart.resetZoom === "function") chart.resetZoom();

  chart.options.scales.x.min = Number.isFinite(NORMAL_MIN_X) ? NORMAL_MIN_X : undefined;
  chart.options.scales.x.max = Number.isFinite(NORMAL_MAX_X) ? NORMAL_MAX_X : undefined;

  chart.options.scales.y.min = undefined;
  chart.options.scales.y.max = undefined;

  chart.update("none");
  captureNormalYBounds();
}

/* ============================================================
   CHART/Graph Setup
   ============================================================ */
function initChart() {
  const ctx = document.getElementById("glucoseChart");
  if (!ctx) return;

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        { label:"Glucose", data:[], parsing:false, borderColor:"#09B02C", borderWidth:2, pointRadius:0, tension:0.35,
          segment:{ borderColor:(segCtx)=> {
            const x0 = segCtx.p0.parsed.x, x1 = segCtx.p1.parsed.x;
            if (!Number.isFinite(x0) || !Number.isFinite(x1)) return "#09B02C";
            return (x1-x0 > GAP_BREAK_MS) ? "rgba(0,0,0,0)" : "#09B02C";
          }}
        },
        { label:"Low", data:[], parsing:false, borderColor:"rgba(255,0,0,.82)", borderWidth:1.25, borderDash:[6,6], pointRadius:0 },
        { label:"High", data:[], parsing:false, borderColor:"rgba(255,0,0,.82)", borderWidth:1.25, borderDash:[6,6], pointRadius:0 },

        { label:"Outer low (90%)", data:[], parsing:false, borderColor:"rgba(9,176,44,.28)", borderWidth:1.3, borderDash:[6,6], pointRadius:0, tension:0.35, fill:false },
        { label:"Outer high (90%)", data:[], parsing:false, borderColor:"rgba(9,176,44,.28)", borderWidth:1.3, borderDash:[6,6], pointRadius:0, tension:0.35, fill:{target:3}, backgroundColor:"rgba(9,176,44,.10)" },

        { label:"Inner low (50%)", data:[], parsing:false, borderColor:"rgba(9,176,44,.45)", borderWidth:1.5, borderDash:[4,6], pointRadius:0, tension:0.35, fill:false },
        { label:"Inner high (50%)", data:[], parsing:false, borderColor:"rgba(9,176,44,.45)", borderWidth:1.5, borderDash:[4,6], pointRadius:0, tension:0.35, fill:{target:5}, backgroundColor:"rgba(9,176,44,.18)" },

        { label:"Forecast mean", data:[], parsing:false, borderColor:"rgba(9,176,44,.95)", borderWidth:2, borderDash:[2,8], pointRadius:0, tension:0.35 }
      ]
    },
    options: {
      responsive:true,
      maintainAspectRatio:false,
      animation:false,
      plugins: {
        legend: { display:false },
        zoom: {
          zoom: { wheel:{ enabled:false }, pinch:{ enabled:true }, mode:"xy" },
          pan: { enabled:false, mode:"xy" }
        },
        tooltip: {
          intersect:false,
          mode:"nearest",
          callbacks: {
            title(items){ const x = items?.[0]?.parsed?.x; return x ? new Date(x).toLocaleString() : ""; },
            label(item){ const y = item?.parsed?.y; return Number.isFinite(y) ? (" " + Math.round(y) + " mg/dL") : ""; }
          }
        }
      },
      scales: {
        x: {
          type:"linear",
          grid:{ display:false },
          ticks:{
            maxTicksLimit:6,
            callback:(v)=>new Date(Number(v)).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
          }
        },
        y: {
          suggestedMin:50,
          suggestedMax:250,
          grid:{ color:"rgba(0,0,0,.06)" },
          ticks:{ maxTicksLimit:6 }
        }
      }
    },
    plugins: [rangeBandsPlugin, forecastMarkerPlugin]
  });

  __wheelZoomAttached = false;
  attachPointerWheelZoom();
  setThresholdLabels();
}

/* ============================================================
   RENDER: last hour + forecast envelopes on graph
   ============================================================ */
function renderLastHour(points) {
  if (!chart) return;

  const pts = normalizeDexcomPoints(points);

  // ✅ ALWAYS update analysis (even if chart has no points)
  updateAnalysisUI(pts);

  const anchor = pts.length ? pts[pts.length - 1].x : Date.now();
  const minX = anchor - WINDOW_MS;
  const maxX = anchor + (PRED_HORIZON_MIN * 60 * 1000);

  NORMAL_MIN_X = minX;
  NORMAL_MAX_X = maxX;

  const filtered = pts.filter(p => p.x >= minX && p.x <= anchor);

  if (filtered.length) {
    const lastReal = filtered[filtered.length - 1];
    FORECAST_X_MS = lastReal.x;
    FORECAST_Y = lastReal.y;
  } else {
    FORECAST_X_MS = null;
    FORECAST_Y = null;
  }

  const fc = buildCgmForecastWithBands(points);

  chart.data.datasets[0].data = filtered;
  chart.data.datasets[1].data = [{ x:minX, y:RANGE_LOW }, { x:maxX, y:RANGE_LOW }];
  chart.data.datasets[2].data = [{ x:minX, y:RANGE_HIGH }, { x:maxX, y:RANGE_HIGH }];

  chart.data.datasets[3].data = fc.lo90;
  chart.data.datasets[4].data = fc.hi90;
  chart.data.datasets[5].data = fc.lo50;
  chart.data.datasets[6].data = fc.hi50;
  chart.data.datasets[7].data = fc.mean;

  if (!Number.isFinite(chart.options.scales.x.min) || !Number.isFinite(chart.options.scales.x.max)) {
    chart.options.scales.x.min = minX;
    chart.options.scales.x.max = maxX;
    chart.options.scales.y.min = undefined;
    chart.options.scales.y.max = undefined;
  }

  setThresholdLabels();
  setEmpty(filtered.length === 0);

  chart.update("none");
  captureNormalYBounds();
}

/* ============================================================
   Get recent dexcom data
   ============================================================ */
async function loadDexcomRecent() {
  const t = getSessionToken();
  window.__lastDexcomRecentError = "";

  if (!t) {
    window.__lastDexcomRecentError = "No Dexcom session found.";
    setAnalysisState("no_sensor", window.__lastDexcomRecentError);
    return null;
  }

  if (t.startsWith(DEMO_TOKEN_PREFIX)) {
    return makeFakeDexcomRecent({ minutes: 180, stepMin: 5, base: 120 });
  }

  setAnalysisState("connecting");

  try {
    const r = await fetch(API_BASE + "/dexcom-recent?minutes=180&maxCount=72", {
      cache: "no-store",
      credentials: "same-origin",
      headers: authHeaders(),
    });

    const text = await r.text();
    let j = null;

    try {
      j = JSON.parse(text);
    } catch {
      window.__lastDexcomRecentError = text || "Dexcom returned an invalid response.";
      setAnalysisState("no_sensor", window.__lastDexcomRecentError);
      setEmpty(true);
      return null;
    }

    if (j?.status === "no_active_sensor") {
      window.__lastDexcomRecentError = j?.message || "No active Dexcom sensor session.";
      setAnalysisState("no_sensor", window.__lastDexcomRecentError);
      setEmpty(true);
      return j;
    }

    if (!r.ok || !j || !j.ok) {
      window.__lastDexcomRecentError = j?.error || text || `Dexcom data request failed (${r.status}).`;
      setAnalysisState("no_sensor", window.__lastDexcomRecentError);
      setEmpty(true);
      return null;
    }

    window.__lastDexcomRecentError = "";
    if (!j.points || j.points.length === 0) {
      setAnalysisState("no_data");
    } else {
      setAnalysisState("live");
    }

    return j;
  } catch (err) {
    window.__lastDexcomRecentError = err?.message || "Dexcom data request failed.";
    setAnalysisState("no_sensor", window.__lastDexcomRecentError);
    setEmpty(true);
    return null;
  }
}

/* ============================================================
   Right now glucose information
   ============================================================ */
async function refreshLatestCardFromRecent(recent) {
  if (!recent?.latest) return;
  const l = recent.latest;

  document.getElementById("glucose-value").textContent = l.glucose ?? "—";
  document.getElementById("glucose-trend").textContent = "Trend: " + (l.trend ?? "—");
  document.getElementById("glucose-time").textContent =
    "Dexcom time: " + new Date(l.ts * 1000).toLocaleString();

  const ageEl = document.getElementById("glucose-age");
  if (ageEl && Number.isFinite(l.ts)) {
    const ageMs = Date.now() - (l.ts * 1000);
    const ageMin = Math.max(0, Math.round(ageMs / 60000));
    ageEl.textContent = "Age: " + ageMin + " min";
  }
}

/* ============================================================
   Check if robot is connected
   ============================================================ */
async function updateStatus() {
  const el = document.getElementById("wifi-status");
  if (!el) return;

  if (!getCurrentDeviceId()) {
    el.textContent = "Not paired yet";
    el.style.color = "grey";
    return;
  }

  try {
    const res = await fetch(buildDeviceApiUrl("/status"), {
      cache: "no-store",
      credentials: "same-origin"
    });
    const data = await res.json();

    if (!data.lastSeen) {
      el.textContent = "Waiting for GUARD heartbeat…";
      el.style.color = "grey";
      return;
    }

    if (data.online) {
      el.textContent = "Connected";
      el.style.color = "green";
    } else {
      el.textContent = "Disconnected (no heartbeat)";
      el.style.color = "red";
    }
  } catch {
    el.textContent = "Status error";
    el.style.color = "red";
  }
}
function setAnalysisState(state, extra = "") {
  const avgEl = document.getElementById("avgchg");
  const urgEl = document.getElementById("Urgency");

  if (!avgEl || !urgEl) return;

  if (state === "connecting") {
    avgEl.textContent = "Average change (1h): Connecting to Dexcom…";
    urgEl.textContent = "Urgency: Checking CGM session…";
    dbg(extra || "Connecting to Dexcom...");
    return;
  }

  if (state === "no_sensor") {
    avgEl.textContent = "Average change (1h): No Dexcom connected";
    urgEl.textContent = "Urgency: No CGM session detected";
    dbg(extra || "Dexcom connected but no active sensor session.");
    return;
  }

  if (state === "no_data") {
    avgEl.textContent = "Average change (1h): Waiting for data…";
    urgEl.textContent = "Urgency: Waiting for data…";
    dbg(extra || "No glucose points available yet.");
    return;
  }

  if (state === "live") {
    dbg(extra || "");
  }
}
/* ============================================================
   SETTINGS customizer
   ============================================================ */
async function loadSettingsIntoForm() {
  try {
    const mailbox = await getMailbox();

    RANGE_LOW = Number(mailbox.glucose_low ?? 80) || 80;
    RANGE_HIGH = Number(mailbox.glucose_high ?? 180) || 180;

    document.getElementById("lowInput").value = RANGE_LOW;
    document.getElementById("highInput").value = RANGE_HIGH;

    setThresholdLabels();
    if (chart) chart.update("none");
  } catch {}
}

document.getElementById("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const low = Number(document.getElementById("lowInput").value);
  const high = Number(document.getElementById("highInput").value);

  const statusEl = document.getElementById("settingsStatus");
  statusEl.textContent = "Saving…";

  try {
    const mailbox = await setMailbox({
      glucose_low: low,
      glucose_high: high
    });

    statusEl.textContent = "Saved ✅";

    RANGE_LOW = Number(mailbox.glucose_low ?? low) || RANGE_LOW;
    RANGE_HIGH = Number(mailbox.glucose_high ?? high) || RANGE_HIGH;

    NORMAL_MIN_Y = null;
    NORMAL_MAX_Y = null;

    setThresholdLabels();

    const recent = await loadDexcomRecent();
    if (!recent) return;

    if (recent.status === "no_active_sensor") {
      showNoActiveSensorUI()
    } else {
      renderLastHour(recent.points);
      await refreshLatestCardFromRecent(recent);
    }
  } catch {
    statusEl.textContent = "Save failed ❌";
  }
});

/* ============================================================
   LOGIN FLOW
   ============================================================ */
async function saveDexcomCreds() {
  const username = document.getElementById("dxUser").value.trim();
  const password = document.getElementById("dxPass").value.trim();
  const region = document.getElementById("dxRegion").value;
  const stateEl = document.getElementById("dexcom-state");

  stateEl.textContent = "Logging in...";
  dbg("Starting login...");

  if (username === DEMO_USER && password === DEMO_PASS) {
    const demoToken = DEMO_TOKEN_PREFIX + "local-demo";
    setSessionToken(demoToken);
    stateEl.textContent = "Logged in (Developer Mode)";
    dbg("Demo login success. Opening dashboard...");
    await enterDashboard();
    return;
  }

  try {
    const res = await fetch("/dexcom-login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, region })
    });

    const text = await res.text();
    let data = null;

    try {
      data = JSON.parse(text);
    } catch {
      const loginError = text || "Login failed";
      dbg("Login response was not valid JSON: " + loginError);
      stateEl.textContent = loginError;
      return;
    }

    if (!res.ok || !data.ok) {
      const loginError = data?.error || text || "Login failed";
      dbg("Login failed: " + loginError);
      stateEl.textContent = loginError;
      return;
    }

    const sessionState = await refreshSessionState();
    if (!sessionState.logged_in) {
      stateEl.textContent = "Login succeeded, but the secure session was not saved.";
      dbg("Secure session cookie was missing after login.");
      return;
    }

    setSessionToken("server-session");
    stateEl.textContent = "Logged in";

    if (Number.isFinite(Number(data?.trusted_users_count))) {
      setTrustedUsersCount(Number(data.trusted_users_count));
    } else {
      await loadTrustedUsersCount();
    }
    if (!sessionState.device_id) {
      setClaimCardVisible(true, {
        help: "Optional: pair your GUARD anytime by entering the claim code shown after Bluetooth or GUARD-SETUP setup.",
        state: "Logged in. You can use Guardian now, even without a GUARD device."
      });
      stateEl.textContent = "Logged in";
    }

    dbg("Login success. Entering dashboard...");
    await enterDashboard();

  } catch (err) {
    const loginError = err?.message || String(err) || "Login failed";
    dbg("Login fetch error: " + loginError);
    stateEl.textContent = loginError;
  }
}

/* ============================================================
   Logout
   ============================================================ */
async function logout() {
  const wasDemo = getSessionToken().startsWith(DEMO_TOKEN_PREFIX);
  setSessionToken("");
  setCurrentDeviceId("");
  setClaimCardVisible(false, { state: "" });
  document.getElementById("dexcom-state").textContent = "Not logged in";

  // Demo mode lives only in the browser, so there is no server session to clear.
  if (wasDemo) {
    alert("Logged out");
    return;
  }

  try {
    await fetch("/dexcom-logout", {
      method:"POST",
      credentials: "same-origin"
    });
  } catch {}

  alert("Logged out");
}

/* ============================================================
   ENTER DASHBOARD function
   ============================================================ */
function showNoActiveSensorUI() {
  renderLastHour([]);
  document.getElementById("glucose-value").textContent = "—";
  document.getElementById("glucose-trend").textContent = "Trend: —";
  document.getElementById("glucose-time").textContent = "No active Dexcom sensor";
  document.getElementById("glucose-age").textContent = "—";
}
async function enterDashboard(){
  if (!getSessionToken()) {
    alert("Please log in with Dexcom first.");
    return;
  }

  setClaimCardVisible(false, { state: "" });
  showPage("content");

  updateAnalysisUI([]);
  dbg("Dashboard entered. Loading Dexcom data…");
  await new Promise(requestAnimationFrame);
  initChart();
  await loadSettingsIntoForm();

  const recent = await loadDexcomRecent();
  if (!recent) {
    const recentError = window.__lastDexcomRecentError || "Could not load Dexcom data after login.";
    dbg("Recent Dexcom load failed: " + recentError);
    document.getElementById("dexcom-state").textContent = recentError;
    alert(recentError);
    return;
  }

  if (recent.status === "no_active_sensor") {
    showNoActiveSensorUI()
  } else {
    renderLastHour(recent.points);
    await refreshLatestCardFromRecent(recent);
  }

  updateStatus();

  const devMode = getSessionToken().startsWith(DEMO_TOKEN_PREFIX);
  const titleEl = document.getElementById("dashboardTitle");
  if (titleEl) {
    titleEl.textContent = devMode ? "Dashboard Developer Mode" : "Dashboard";
    titleEl.style.color = devMode ? "var(--g)" : "var(--ink)";
    titleEl.style.opacity = devMode ? "1" : ".95";
    titleEl.style.textShadow = devMode ? "0 6px 18px rgba(250,250,250,.1)" : "none";
  }

  if (!window.__pollersStarted) {
    window.__pollersStarted = true;

  setInterval(async () => {
    const r = await loadDexcomRecent();
    if (!r) return;

    if (r.status === "no_active_sensor") {
      showNoActiveSensorUI()
      return;
    }

    renderLastHour(r.points);
    await refreshLatestCardFromRecent(r);
  }, 60000);

    setInterval(updateStatus, 5000);
  }
}

async function bootstrapExistingSession() {
  const session = await refreshSessionState();
  if (!session.logged_in) {
    setClaimCardVisible(false, { state: "" });
    return;
  }

  document.getElementById("dexcom-state").textContent =
    session.demo ? "Logged in (Developer Mode)" : "Logged in";

  if (Number.isFinite(Number(session?.trusted_users_count))) {
    setTrustedUsersCount(Number(session.trusted_users_count));
  } else {
    await loadTrustedUsersCount();
  }

  await enterDashboard();
}

/* ============================================================
   MANUAL POLL
   ============================================================ */
async function pollDexcomNow() {
  const el = document.getElementById("poll-status");
  el.textContent = "Refreshing…";

  const r = await loadDexcomRecent();
  if (!r) {
    el.textContent = "Dexcom unavailable";
    alert("Could not load Dexcom data.");
    return;
  }

  if (r.status === "no_active_sensor") {
    renderLastHour([]);
    document.getElementById("glucose-value").textContent = "—";
    document.getElementById("glucose-trend").textContent = "Trend: —";
    document.getElementById("glucose-time").textContent = "No active Dexcom sensor";
    document.getElementById("glucose-age").textContent = "—";
    el.textContent = "No active sensor";
    return;
  }

  renderLastHour(r.points);
  await refreshLatestCardFromRecent(r);
  el.textContent = "Updated ✅";
}

function makeFakeDexcomRecent({ minutes = 180, stepMin = 5, base = 120 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const count = Math.floor(minutes / stepMin) + 1;

  let g = base + (Math.random() * 10 - 5);
  let slope = (Math.random() * 2 - 1) * 0.18; // mg/dL per minute-ish

  const points = [];
  for (let k = count - 1; k >= 0; k--) {
    const ts = nowSec - k * stepMin * 60;

    // drift
    g += slope * stepMin;

    // wiggle + noise
    g += Math.sin((ts / 60) / 10) * 1.2;
    g += (Math.random() * 6 - 3) * 0.35;

    // occasional meal bump / correction dip
    if (Math.random() < 0.03) { g += 25 + Math.random() * 35; slope += 0.22; }
    if (Math.random() < 0.02) { g -= 15 + Math.random() * 25; slope -= 0.22; }

    slope = clamp(slope, -1.2, 1.2);
    g = clamp(g, 55, 300);

    points.push({ ts, glucose: Math.round(g) });
  }

  const latestPt = points[points.length - 1];
  return {
    ok: true,
    points,
    latest: { ts: latestPt.ts, glucose: latestPt.glucose, trend: "Flat" }
  };
}

/* ============================================================
   Chart Main
   ============================================================ */
let chart;

const WINDOW_MS = 60 * 60 * 1000;
/*hour in miliseconds*/
const GAP_BREAK_MS = 7 * 60 * 1000;
/*7 minutes in milliseconds*/

const PRED_HORIZON_MIN = 30;
/*predict 30 minutes into the future*/
const PRED_STEP_MIN = 5;
/*prediction step every 5 minutes*/

let RANGE_LOW = 80;
/*base low range*/
let RANGE_HIGH = 180;
/*base high range*/

/*until their defined they are null*/
let FORECAST_X_MS = null;
let FORECAST_Y = null;
let NORMAL_MIN_X = null;
let NORMAL_MAX_X = null;
let NORMAL_MIN_Y = null;
let NORMAL_MAX_Y = null;

/* ============================================================
   SETUP STEPS Main
   ============================================================ */
let step = 0;
const dots = document.querySelectorAll(".step-dot");
const steps = Array.from(document.querySelectorAll(".step-panel"));
const nextBtn = document.getElementById("nextBtn");
const backBtn = document.getElementById("backBtn");
const LAST_STEP = steps.length - 1;
document.getElementById("dexcom-state").textContent = "Not logged in";

/* ============================================================
   STARTUP Main
   ============================================================ */
initHeroModelViewer();
setStep(0);
initGuardBluetoothSetup();
void bootstrapExistingSession();

  
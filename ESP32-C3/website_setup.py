import network
import socket
import time
import ure
import _thread
import gc
import machine
import ubinascii
import os
import urequests
import ujson

# ============================================================
# COMBINED ESP32 SCRIPT
# ============================================================
# This file combines:
# 1. The captive portal / Wi-Fi setup flow from
#    User-wifi-device-cloudfare-connect.py
# 2. The newer Worker settings + mailbox flow from website_setup.py
#
# The result is:
# - The ESP32 can connect to known Wi-Fi credentials first.
# - If that fails, it opens a local setup portal so a user can enter Wi-Fi.
# - After Wi-Fi is connected, it talks to the Cloudflare Worker.
# - It syncs thresholds and all other custom values from the mailbox.
#
# The mailbox is the flexible part:
# your website can write any keys into /mailbox, and the ESP32 can read them.
# ============================================================

# ============================================================
# WORKER ENDPOINTS
# ============================================================
WORKER_BASE = "https://getguardian.org"

# ============================================================
# DEVICE PAIRING
# ============================================================
# Customer-friendly pairing flow:
# - This ESP32 creates its own local hardware identity automatically.
# - It sends that identity to the Worker.
# - The Worker returns a temporary claim code.
# - The user enters that claim code on the Guardian website.
# - Once claimed, the Worker gives the ESP32 its secure device_id/device_token.
# - The ESP32 saves those credentials locally and uses them from then on.
#
# These override values are only for emergency developer testing.
# A normal customer should leave both blank.
DEVICE_ID = ""
DEVICE_TOKEN = ""

# ============================================================
# OPTIONAL DEFAULT WI-FI
# ============================================================
# If these are filled in, the ESP32 tries them first on boot.
# If the connection fails, it falls back to the captive portal.
#
# If you want the setup portal every time, set both of these to "".
DEFAULT_WIFI_SSID = ""
DEFAULT_WIFI_PASS = ""

# ============================================================
# LOCAL FILES
# ============================================================
# value.txt keeps the low threshold for backward compatibility with older code.
# glucose_high.txt keeps the high threshold.
# mailbox.json stores the last mailbox the board received from the Worker.
VALUE_FILE = "value.txt"
HIGH_VALUE_FILE = "glucose_high.txt"
MAILBOX_FILE = "mailbox.json"
BOOTSTRAP_FILE = "device_bootstrap.json"
DEVICE_CREDS_FILE = "device_credentials.json"
CLAIM_INFO_FILE = "device_claim.json"

# ============================================================
# TIMING
# ============================================================
POLL_INTERVAL = 1
HEARTBEAT_INTERVAL = 15
WORKER_CHECK_INTERVAL = 5
WIFI_TIMEOUT = 25
BOOTSTRAP_RETRY_INTERVAL = 10

# ============================================================
# CAPTIVE PORTAL CONFIG
# ============================================================
AP_SSID = "GUARD-SETUP"
PORTAL_PORT = 80

# ============================================================
# CAPTIVE PORTAL HTML
# ============================================================
PORTAL_PAGE = """<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wi-Fi Setup</title>
<style>
body{
  margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,system-ui,sans-serif;
  background:radial-gradient(circle at top,#d9ffe0,#f4fff6,#ffffff);
}
.glass{
  width:90%;max-width:360px;padding:26px;border-radius:22px;
  background:rgba(255,255,255,.55);
  backdrop-filter:blur(20px) saturate(180%);
  -webkit-backdrop-filter:blur(20px) saturate(180%);
  box-shadow:0 20px 40px rgba(0,0,0,.15);
  text-align:center;
}
h2{margin:0 0 8px 0;}
p{margin:0 0 18px 0;opacity:.8;}
input{
  width:100%;padding:14px;margin-bottom:14px;border-radius:14px;
  border:none;font-size:16px;background:rgba(255,255,255,.75);
  outline:none;
}
button{
  width:100%;padding:14px;border:none;border-radius:16px;
  font-size:16px;font-weight:800;color:white;background:#0bbf3a;
}
small{display:block;margin-top:10px;opacity:.65;}
</style>
</head>
<body>
<div class="glass">
  <h2>ESP32 Wi-Fi Setup</h2>
  <p>Enter the Wi-Fi this ESP32 should join</p>
  <form method="POST" action="/connect">
    <input name="ssid" placeholder="Wi-Fi name (SSID)" required>
    <input name="password" type="password" placeholder="Password (blank if open)">
    <button type="submit">Connect</button>
  </form>
  <small>If the page does not open automatically, open Safari and type anything.</small>
</div>
</body>
</html>
"""

# ============================================================
# NETWORK INTERFACES
# ============================================================
# STA_IF is the normal Wi-Fi client interface used to join home/school Wi-Fi.
# AP_IF is the access-point interface used for the setup portal.
sta = network.WLAN(network.STA_IF)
sta.active(True)

# ============================================================
# SIMPLE FILE HELPERS
# ============================================================
def load_value(path, default=0):
    try:
        with open(path, "r") as f:
            return int(f.read().strip())
    except:
        return default

def save_value(path, value):
    try:
        with open(path, "w") as f:
            f.write(str(value))
    except:
        pass

def load_json_file(path, default=None):
    try:
        with open(path, "r") as f:
            return ujson.loads(f.read())
    except:
        return default if default is not None else {}

def save_json_file(path, value):
    try:
        with open(path, "w") as f:
            f.write(ujson.dumps(value))
    except:
        pass

# ============================================================
# HTTP / WORKER HELPERS
# ============================================================
# In the product-friendly setup, the ESP32 stores two layers of identity:
#
# 1. Bootstrap identity:
#    - hardware_id
#    - bootstrap_secret
#    These are used only during first-time onboarding and claiming.
#
# 2. Claimed device credentials:
#    - device_id
#    - device_token
#    These are the normal long-lived credentials used for heartbeat/mailbox.
current_device_credentials = None

def random_hex(byte_count=16):
    try:
        return ubinascii.hexlify(os.urandom(byte_count)).decode()
    except:
        seed = "{}-{}-{}".format(time.time(), time.ticks_ms(), ubinascii.hexlify(machine.unique_id()).decode())
        return ubinascii.hexlify(seed.encode()).decode()[:byte_count * 2]

def get_bootstrap_identity():
    identity = load_json_file(BOOTSTRAP_FILE, {})
    hardware_id = str(identity.get("hardware_id") or "").strip().lower()
    bootstrap_secret = str(identity.get("bootstrap_secret") or "").strip()

    if not hardware_id:
        hardware_id = "guard-" + ubinascii.hexlify(machine.unique_id()).decode().lower()

    if not bootstrap_secret:
        bootstrap_secret = random_hex(16)

    clean = {
        "hardware_id": hardware_id,
        "bootstrap_secret": bootstrap_secret,
    }

    if clean != identity:
        save_json_file(BOOTSTRAP_FILE, clean)

    return clean

def load_device_credentials():
    if DEVICE_ID and DEVICE_ID.strip() and DEVICE_TOKEN and DEVICE_TOKEN.strip():
        return {
            "device_id": DEVICE_ID.strip().lower(),
            "device_token": DEVICE_TOKEN.strip(),
            "manual_override": True,
        }

    saved = load_json_file(DEVICE_CREDS_FILE, {})
    device_id = str(saved.get("device_id") or "").strip().lower()
    device_token = str(saved.get("device_token") or "").strip()

    if device_id and device_token:
        return {
            "device_id": device_id,
            "device_token": device_token,
            "manual_override": False,
        }

    return {}

def get_active_device_credentials():
    global current_device_credentials

    if DEVICE_ID and DEVICE_ID.strip() and DEVICE_TOKEN and DEVICE_TOKEN.strip():
        return {
            "device_id": DEVICE_ID.strip().lower(),
            "device_token": DEVICE_TOKEN.strip(),
            "manual_override": True,
        }

    if not isinstance(current_device_credentials, dict) or not current_device_credentials:
        current_device_credentials = load_device_credentials()

    return current_device_credentials or {}

def save_device_credentials(device_id, device_token):
    global current_device_credentials

    creds = {
        "device_id": str(device_id or "").strip().lower(),
        "device_token": str(device_token or "").strip(),
        "saved_at": time.time(),
    }

    save_json_file(DEVICE_CREDS_FILE, creds)
    current_device_credentials = creds

def device_credentials_ready():
    creds = get_active_device_credentials()
    return bool(creds.get("device_id") and creds.get("device_token"))

def worker_url(path, include_device=True):
    if include_device:
        creds = get_active_device_credentials()
        device_id = str(creds.get("device_id") or "").strip()
        if device_id:
            return "{}{}?device_id={}".format(WORKER_BASE, path, device_id)
    return WORKER_BASE + path

def device_headers():
    creds = get_active_device_credentials()
    headers = {}
    token = str(creds.get("device_token") or "").strip()
    if token:
        headers["X-Device-Token"] = token
    return headers

# This is a safer JSON fetch helper than the original /get polling code.
# It checks:
# - request success
# - HTTP status
# - whether the response looks like JSON
# - whether the JSON can actually be parsed
#
# It returns:
# - (parsed_json, None) on success
# - (None, error_message) on failure
def get_json(url, timeout=8, headers=None):
    r = None
    try:
        r = urequests.get(url, timeout=timeout, headers=headers or {})
        status = getattr(r, "status_code", None)
        text = r.text or ""
        trimmed = text.lstrip()

        if status != 200:
            return None, "HTTP {}".format(status)

        if not trimmed:
            return None, "Empty response"

        if not (trimmed.startswith("{") or trimmed.startswith("[")):
            return None, "Response was not JSON: {}".format(trimmed[:80])

        return ujson.loads(text), None
    except Exception as e:
        return None, str(e)
    finally:
        if r:
            try:
                r.close()
            except:
                pass

def post_json(url, payload, timeout=8, headers=None):
    r = None
    try:
        req_headers = {"Content-Type": "application/json"}
        if headers:
            req_headers.update(headers)

        r = urequests.post(
            url,
            data=ujson.dumps(payload or {}),
            timeout=timeout,
            headers=req_headers
        )
        status = getattr(r, "status_code", None)
        text = r.text or ""
        trimmed = text.lstrip()

        if status != 200:
            return None, "HTTP {}".format(status)

        if not trimmed:
            return None, "Empty response"

        if not (trimmed.startswith("{") or trimmed.startswith("[")):
            return None, "Response was not JSON: {}".format(trimmed[:80])

        return ujson.loads(text), None
    except Exception as e:
        return None, str(e)
    finally:
        if r:
            try:
                r.close()
            except:
                pass

def bootstrap_device():
    identity = get_bootstrap_identity()
    payload = {
        "hardware_id": identity.get("hardware_id"),
        "bootstrap_secret": identity.get("bootstrap_secret"),
    }

    data, err = post_json(WORKER_BASE + "/device/bootstrap", payload, timeout=8)
    if err:
        return None, err

    if not data or not data.get("ok"):
        return None, "Bad bootstrap response"

    if data.get("claimed") and data.get("device_id") and data.get("device_token"):
        save_device_credentials(data.get("device_id"), data.get("device_token"))
        save_json_file(CLAIM_INFO_FILE, {
            "claimed": True,
            "device_id": data.get("device_id"),
            "updated_at": time.time(),
        })
        return {
            "claimed": True,
            "device_id": data.get("device_id"),
            "device_token": data.get("device_token"),
        }, None

    claim_code = str(data.get("claim_code") or "").strip().upper()
    if claim_code:
        info = {
            "claimed": False,
            "claim_code": claim_code,
            "claim_expires_at": data.get("claim_expires_at"),
            "claim_url": data.get("claim_url") or WORKER_BASE,
            "updated_at": time.time(),
        }
        save_json_file(CLAIM_INFO_FILE, info)
        return info, None

    return None, "Bootstrap response missing claim information"

def ensure_device_claimed():
    while not device_credentials_ready():
        info, err = bootstrap_device()
        if err:
            print("Bootstrap error:", err)
        elif info.get("claimed"):
            print("Device claimed:", info.get("device_id"))
            return True
        else:
            print("Waiting to be claimed.")
            print("Pairing code:", info.get("claim_code"))
            print("Claim at:", info.get("claim_url"))

        time.sleep(BOOTSTRAP_RETRY_INTERVAL)

    return True

# MAILBOX OVERVIEW
# The mailbox is one JSON object for this specific device on the Worker.
#
# Website example:
#   await setMailbox({
#       glucose_low: 80,
#       glucose_high: 180,
#       current_glucose: 142,
#       predicted_far: 185,
#       message: "Drink water",
#       robot_mode: "alert"
#   });
#
# ESP32 example:
#   glucose_low = current_mailbox.get("glucose_low")
#   glucose_high = current_mailbox.get("glucose_high")
#   current_glucose = current_mailbox.get("current_glucose")
#   robot_mode = current_mailbox.get("robot_mode")
#
# This is now the only place this ESP32 reads low/high thresholds from.
# It is also the easiest way to send new values to the board because you usually
# only add a new key instead of building a whole new endpoint.
# The important safety difference now is that the mailbox belongs to one
# device_id instead of being shared by every ESP32.
def get_mailbox():
    if not device_credentials_ready():
        return None, "Missing DEVICE_ID or DEVICE_TOKEN"

    data, err = get_json(
        worker_url("/mailbox"),
        timeout=8,
        headers=device_headers()
    )
    if err:
        return None, err

    if not data or not data.get("ok"):
        return None, "Bad mailbox response"

    mailbox = data.get("mailbox", {})
    if not isinstance(mailbox, dict):
        return None, "Mailbox response missing object"

    return mailbox, None

def send_heartbeat():
    if not device_credentials_ready():
        return False

    data, err = get_json(
        worker_url("/heartbeat"),
        timeout=5,
        headers=device_headers()
    )
    return not err and bool(data and data.get("ok"))

def worker_reachable():
    if not device_credentials_ready():
        return False

    mailbox, err = get_mailbox()
    return not err and bool(mailbox is not None)

# ============================================================
# URL DECODE + FORM PARSE
# ============================================================
HEX = "0123456789ABCDEFabcdef"

def url_decode(s):
    s = ure.sub(r"\+", " ", s)
    out = []
    i = 0
    L = len(s)

    while i < L:
        ch = s[i]
        if ch == "%" and i + 2 < L and (s[i + 1] in HEX) and (s[i + 2] in HEX):
            try:
                out.append(chr(int(s[i + 1:i + 3], 16)))
                i += 3
                continue
            except:
                pass

        out.append(ch)
        i += 1

    return "".join(out)

def parse_form(body):
    params = {}
    for pair in body.split("&"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            params[url_decode(k)] = url_decode(v)
    return params

# ============================================================
# HTTP SERVER HELPERS FOR THE CAPTIVE PORTAL
# ============================================================
def http_response(conn, code, content_type, body):
    if code == 200:
        reason = "OK"
    elif code == 302:
        reason = "Found"
    else:
        reason = "Not Found"

    hdr = "HTTP/1.1 {} {}\r\n".format(code, reason)
    hdr += "Content-Type: {}\r\n".format(content_type)
    hdr += "Content-Length: {}\r\n".format(len(body))
    hdr += "Connection: close\r\n\r\n"
    conn.send(hdr)

    if body:
        conn.send(body)

def read_http_request(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(1024)
        if not chunk:
            break
        data += chunk
        if len(data) > 8192:
            break

    try:
        head, body = data.split(b"\r\n\r\n", 1)
    except:
        head, body = data, b""

    head_s = head.decode("utf-8", "ignore")
    lines = head_s.split("\r\n")
    if not lines or len(lines[0].split()) < 2:
        return None, None, {}, ""

    parts = lines[0].split()
    method = parts[0]
    path = parts[1]

    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if method == "POST":
        clen = 0
        try:
            clen = int(headers.get("content-length", "0"))
        except:
            clen = 0

        while len(body) < clen:
            more = conn.recv(1024)
            if not more:
                break
            body += more

    return method, path, headers, body.decode("utf-8", "ignore")

# ============================================================
# WI-FI CONNECTION
# ============================================================
def connect_sta(ssid, password):
    print("Connecting to Wi-Fi:", ssid)

    try:
        sta.disconnect()
    except:
        pass

    time.sleep(0.3)

    if password and password.strip():
        sta.connect(ssid, password)
    else:
        sta.connect(ssid)

    start = time.time()
    while not sta.isconnected():
        if time.time() - start > WIFI_TIMEOUT:
            print("Wi-Fi connect timeout")
            try:
                sta.disconnect()
            except:
                pass
            return False
        time.sleep(0.3)

    print("Wi-Fi connected:", sta.ifconfig())
    return True

# ============================================================
# CAPTIVE PORTAL
# ============================================================
# This creates a temporary Wi-Fi network called GUARD-SETUP.
# A phone/laptop joins that network, opens a small web page, and submits
# the real Wi-Fi credentials the ESP32 should use.
def run_captive_portal():
    ap = network.WLAN(network.AP_IF)
    ap.active(True)
    ap.config(essid=AP_SSID, authmode=network.AUTH_OPEN)

    ap_ip = ap.ifconfig()[0]
    ip_bytes = bytes(map(int, ap_ip.split(".")))
    print("AP started:", AP_SSID, "at", ap_ip)

    dns = None
    try:
        dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        dns.bind(("0.0.0.0", 53))
    except Exception as e:
        print("DNS bind failed:", e)
        dns = None

    portal_running = True

    def dns_loop():
        if dns is None:
            return

        while portal_running and ap.active():
            try:
                data, addr = dns.recvfrom(512)
                dns.sendto(
                    data[:2] + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" +
                    data[12:] +
                    b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" +
                    ip_bytes,
                    addr
                )
            except:
                pass

    if dns is not None:
        _thread.start_new_thread(dns_loop, ())

    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", PORTAL_PORT))
    server.listen(5)
    server.settimeout(1.0)

    print("Captive portal running at http://{}".format(ap_ip))

    captive_paths = (
        "/",
        "/generate_204",
        "/hotspot-detect.html",
        "/library/test/success.html",
        "/success.txt",
        "/connecttest.txt",
        "/redirect",
        "/ncsi.txt",
    )

    chosen_ssid = None
    chosen_pass = ""

    while portal_running:
        try:
            conn, addr = server.accept()
        except OSError:
            continue
        except Exception as e:
            print("Accept error:", e)
            continue

        try:
            method, path, headers, body = read_http_request(conn)
            if method is None:
                try:
                    conn.close()
                except:
                    pass
                continue

            if path in captive_paths or path.startswith("/?"):
                http_response(conn, 200, "text/html", PORTAL_PAGE)
                conn.close()
                continue

            if method == "POST" and path == "/connect":
                params = parse_form(body)
                ssid = (params.get("ssid") or "").strip()
                pw = params.get("password") or ""

                if not ssid:
                    http_response(
                        conn,
                        200,
                        "text/html",
                        "<html><body>Missing SSID. <a href='/'>Back</a></body></html>"
                    )
                    conn.close()
                    continue

                if not connect_sta(ssid, pw):
                    http_response(
                        conn,
                        200,
                        "text/html",
                        (
                            "<html><body style='font-family:system-ui;text-align:center;padding:24px;'>"
                            "<h3>Could not connect</h3>"
                            "<p>Guardian could not join <b>{}</b>.</p>"
                            "<p>Please go back and check the Wi-Fi name and password.</p>"
                            "<p><a href='/'>Try again</a></p>"
                            "</body></html>"
                        ).format(ssid)
                    )
                    conn.close()
                    continue

                bootstrap_info, bootstrap_err = bootstrap_device()

                if bootstrap_err:
                    done_page = (
                        "<html><body style='font-family:system-ui;text-align:center;padding:24px;'>"
                        "<h3>Wi-Fi Connected</h3>"
                        "<p>Guardian joined <b>{}</b>.</p>"
                        "<p>We could not reach Guardian cloud yet.</p>"
                        "<p>Please keep the device powered on and try the website in a moment.</p>"
                        "<p>You can close this tab.</p>"
                        "</body></html>"
                    ).format(ssid)
                elif bootstrap_info.get("claimed"):
                    done_page = (
                        "<html><body style='font-family:system-ui;text-align:center;padding:24px;'>"
                        "<h3>Guardian Ready</h3>"
                        "<p>This device is already claimed and connected.</p>"
                        "<p>You can close this tab and return to Guardian.</p>"
                        "</body></html>"
                    )
                else:
                    done_page = (
                        "<html><body style='font-family:system-ui;text-align:center;padding:24px;'>"
                        "<h3>Wi-Fi Connected</h3>"
                        "<p>Guardian joined <b>{}</b>.</p>"
                        "<p>Enter this pairing code on <b>getguardian.org</b>:</p>"
                        "<h1 style='letter-spacing:4px;font-size:32px;'>{}</h1>"
                        "<p>Keep the device powered on while you claim it.</p>"
                        "<p>You can close this tab after entering the code.</p>"
                        "</body></html>"
                    ).format(ssid, bootstrap_info.get("claim_code") or "----")

                http_response(conn, 200, "text/html", done_page)
                conn.close()

                chosen_ssid = ssid
                chosen_pass = pw
                portal_running = False
                break

            http_response(conn, 200, "text/html", PORTAL_PAGE)
            conn.close()

        except Exception as e:
            try:
                conn.close()
            except:
                pass
            print("Request error:", e)

    try:
        server.close()
    except:
        pass

    try:
        if dns is not None:
            dns.close()
    except:
        pass

    try:
        ap.active(False)
    except:
        pass

    return chosen_ssid, chosen_pass

# ============================================================
# WORKER SYNC LOOP
# ============================================================
# Once Wi-Fi is connected, this loop:
# - sends heartbeat updates
# - reads the shared mailbox
# - saves the latest values locally
#
# If Wi-Fi drops, it returns so main() can reconnect or reopen the portal.
def cloudflare_loop():
    print("Cloudflare sync loop started")

    current_low = load_value(VALUE_FILE, 70)
    current_high = load_value(HIGH_VALUE_FILE, 180)
    current_mailbox = load_json_file(MAILBOX_FILE, {})

    print("Loaded low/high:", current_low, current_high)
    print("Loaded mailbox:", current_mailbox)

    last_heartbeat = 0
    last_worker_check = 0

    while True:
        try:
            gc.collect()

            if not sta.isconnected():
                print("Wi-Fi disconnected. Leaving cloud loop.")
                return

            now = time.time()

            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                if send_heartbeat():
                    last_heartbeat = now
                    print("Heartbeat sent")
                else:
                    print("Heartbeat failed")

            if now - last_worker_check >= WORKER_CHECK_INTERVAL:
                last_worker_check = now

                new_mailbox, mailbox_err = get_mailbox()
                if mailbox_err:
                    print("Mailbox error:", mailbox_err)
                else:
                    new_low = int(new_mailbox.get("glucose_low", current_low))
                    new_high = int(new_mailbox.get("glucose_high", current_high))

                    if new_low != current_low:
                        current_low = new_low
                        save_value(VALUE_FILE, current_low)
                        print("Updated low:", current_low)

                    if new_high != current_high:
                        current_high = new_high
                        save_value(HIGH_VALUE_FILE, current_high)
                        print("Updated high:", current_high)

                    if new_mailbox != current_mailbox:
                        current_mailbox = new_mailbox
                        save_json_file(MAILBOX_FILE, current_mailbox)
                        print("Updated mailbox:", current_mailbox)

                        # Example reads:
                        # Copy this pattern whenever you add a new mailbox key.
                        #
                        # Example:
                        # robot_mode = current_mailbox.get("robot_mode")
                        # print("robot_mode =", robot_mode)
                        print("glucose_low =", current_mailbox.get("glucose_low"))
                        print("glucose_high =", current_mailbox.get("glucose_high"))
                        print("current_glucose =", current_mailbox.get("current_glucose"))
                        print("predicted_far =", current_mailbox.get("predicted_far"))
                        print("message =", current_mailbox.get("message"))

        except Exception as e:
            print("Cloud loop error:", e)

        time.sleep(POLL_INTERVAL)

# ============================================================
# MAIN
# ============================================================
# Startup strategy:
# 1. Try the optional default Wi-Fi credentials first.
# 2. If they fail, open the setup portal.
# 3. Once connected, keep syncing with the Worker.
# 4. If Wi-Fi drops, loop back and reconnect or reopen the portal.
def main():
    current_ssid = DEFAULT_WIFI_SSID
    current_pass = DEFAULT_WIFI_PASS

    while True:
        if current_ssid:
            if sta.isconnected() or connect_sta(current_ssid, current_pass):
                print("Checking onboarding status...")
                ensure_device_claimed()

                print("Checking Worker connectivity...")
                while not worker_reachable():
                    print("Waiting for Worker...")
                    time.sleep(5)

                cloudflare_loop()
                time.sleep(1)
                continue

            print("Saved/default Wi-Fi failed. Opening setup portal.")

        ssid, pw = run_captive_portal()

        if not ssid:
            print("No SSID received. Restarting portal...")
            time.sleep(1)
            continue

        current_ssid = ssid
        current_pass = pw

        if sta.isconnected() or connect_sta(current_ssid, current_pass):
            print("Checking onboarding status...")
            ensure_device_claimed()

            print("Checking Worker connectivity...")
            while not worker_reachable():
                print("Waiting for Worker...")
                time.sleep(5)

            cloudflare_loop()
            time.sleep(1)
            continue

        print("Failed to connect. Restarting setup flow...")
        time.sleep(1)

main()

import network
import urequests
import ujson
import time
import gc

# ===== CONFIG =====
# SSID = "HCS-Guest"
SSID = "ATT5Hnk3yN"
PASS = "8v7?4j2p=n8p"
WORKER_BASE = "https://getguardian.org"
SETTINGS_URL = WORKER_BASE + "/get-settings"
HEARTBEAT_URL = WORKER_BASE + "/heartbeat"
MAILBOX_URL = WORKER_BASE + "/mailbox"

VALUE_FILE = "value.txt"
HIGH_VALUE_FILE = "glucose_high.txt"
MAILBOX_FILE = "mailbox.json"
POLL_INTERVAL = 1
HEARTBEAT_INTERVAL = 15

# ===== WIFI =====
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID, PASS)

print("Connecting to Wi-Fi...")
while not wlan.isconnected():
    time.sleep(1)

print("Connected:", wlan.ifconfig())

# ===== HTTP HELPERS =====
def get_json(url, timeout=8):
    r = None
    try:
        r = urequests.get(url, timeout=timeout)
        status = getattr(r, "status_code", None)
        text = r.text

        if status != 200:
            return None, "HTTP {}".format(status)

        return ujson.loads(text), None
    except Exception as e:
        return None, str(e)
    finally:
        if r:
            try:
                r.close()
            except:
                pass

# ===== INTERNET CHECK =====
def internet_ok():
    data, err = get_json(SETTINGS_URL, timeout=5)
    if err:
        return False

    return bool(
        data
        and data.get("ok")
        and "glucose_low" in data
        and "glucose_high" in data
    )

print("Checking internet...")
while not internet_ok():
    print("Waiting for internet...")
    time.sleep(5)

print("Internet confirmed!")

# ===== STORAGE =====
def load_value(path, default=0):
    try:
        with open(path) as f:
            return int(f.read())
    except:
        return default

def save_value(path, value):
    with open(path, "w") as f:
        f.write(str(value))

def load_json_file(path, default=None):
    try:
        with open(path) as f:
            return ujson.loads(f.read())
    except:
        return default if default is not None else {}

def save_json_file(path, value):
    with open(path, "w") as f:
        f.write(ujson.dumps(value))

# MAILBOX OVERVIEW
# The mailbox is one shared JSON object that lives in the Worker.
# Your website writes keys into it, and the ESP32 reads them back.
#
# Example mailbox:
# {
#   "current_glucose": 142,
#   "predicted_far": 185,
#   "message": "Drink water",
#   "robot_mode": "alert"
# }
#
# Why this is easier:
# - You do not need a new endpoint for every variable.
# - To add a new variable, you usually just add a new key.
# - The ESP32 can read one object and pull out only the keys it wants.
def get_mailbox():
    data, err = get_json(MAILBOX_URL, timeout=8)
    if err:
        return None, err

    if not data or not data.get("ok"):
        return None, "Bad mailbox response"

    mailbox = data.get("mailbox", {})
    if not isinstance(mailbox, dict):
        return None, "Mailbox response missing object"

    return mailbox, None

# Keep the low threshold in value.txt for backward compatibility.
current_value = load_value(VALUE_FILE, 70)
current_high = load_value(HIGH_VALUE_FILE, 180)
# This keeps the last mailbox on the ESP32 filesystem so you can inspect
# what the device most recently received, even after a reset.
current_mailbox = load_json_file(MAILBOX_FILE, {})
print("Loaded low/high:", current_value, current_high)
print("Loaded mailbox:", current_mailbox)

def save_low(v):
    with open(VALUE_FILE, "w") as f:
        f.write(str(v))

# ===== HEARTBEAT =====
def send_heartbeat():
    data, err = get_json(HEARTBEAT_URL, timeout=5)
    return not err and bool(data and data.get("ok"))

last_heartbeat = 0

# ===== MAIN LOOP =====
while True:
    try:
        gc.collect()

        now = time.time()
        if now - last_heartbeat > HEARTBEAT_INTERVAL:
            if send_heartbeat():
                last_heartbeat = now
                print("Heartbeat sent")

        data, err = get_json(SETTINGS_URL, timeout=8)
        if err:
            print("Settings error:", err)
        elif data and data.get("ok"):
            new_value = int(data.get("glucose_low", current_value))
            new_high = int(data.get("glucose_high", current_high))

            if new_value != current_value:
                current_value = new_value
                save_low(current_value)
                print("Updated low:", current_value)

            if new_high != current_high:
                current_high = new_high
                save_value(HIGH_VALUE_FILE, current_high)
                print("Updated high:", current_high)
        else:
            print("Bad response:", data)

        # Read the shared mailbox every loop.
        # If nothing changed, we do nothing.
        # If something changed, we save the whole mailbox locally and then read
        # whichever keys we care about.
        new_mailbox, mailbox_err = get_mailbox()
        if mailbox_err:
            print("Mailbox error:", mailbox_err)
        elif new_mailbox != current_mailbox:
            current_mailbox = new_mailbox
            save_json_file(MAILBOX_FILE, current_mailbox)
            print("Updated mailbox:", current_mailbox)

            # Example reads:
            # These lines show the exact pattern for pulling values out.
            # To add a new variable later, copy one of these and change the key.
            #
            # Example:
            # print("robot_mode =", current_mailbox.get("robot_mode"))
            print("current_glucose =", current_mailbox.get("current_glucose"))
            print("predicted_far =", current_mailbox.get("predicted_far"))
            print("message =", current_mailbox.get("message"))

    except Exception as e:
        print("Loop error:", e)
        gc.collect()

    time.sleep(POLL_INTERVAL)

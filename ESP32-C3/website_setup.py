import network
import urequests
import ujson
import time
import gc

# ===== CONFIG =====
#SSID = "HCS-Guest"
SSID="ATT5Hnk3yN"
PASS="8v7?4j2p=n8p"
WORKER_BASE = "https://getguardian.org"
SETTINGS_URL = WORKER_BASE + "/get-settings"
HEARTBEAT_URL = WORKER_BASE + "/heartbeat"
DEVICE_STATE_URL = WORKER_BASE + "/device-state"

VALUE_FILE = "value.txt"
HIGH_VALUE_FILE = "glucose_high.txt"
DEVICE_STATE_FILE = "device_state.json"
POLL_INTERVAL = 1        # seconds
HEARTBEAT_INTERVAL = 15   # seconds

# ===== WIFI =====
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID,PASS)

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

# Keep the low threshold in value.txt for backward compatibility.
current_value = load_value(VALUE_FILE, 70)
current_high = load_value(HIGH_VALUE_FILE, 180)
current_device_state = load_json_file(DEVICE_STATE_FILE, {})
print("Loaded low/high:", current_value, current_high)
print("Loaded device state:", current_device_state)

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

        state_data, state_err = get_json(DEVICE_STATE_URL, timeout=8)
        if state_err:
            print("Device state error:", state_err)
        elif state_data and state_data.get("ok"):
            new_state = state_data.get("state", {})
            if isinstance(new_state, dict) and new_state != current_device_state:
                current_device_state = new_state
                save_json_file(DEVICE_STATE_FILE, current_device_state)
                print("Updated device state:", current_device_state)

                if "current_glucose" in current_device_state:
                    print("Current glucose:", current_device_state.get("current_glucose"))

                if "predicted_far" in current_device_state:
                    print("Predicted far:", current_device_state.get("predicted_far"))

                if "message" in current_device_state:
                    print("Message:", current_device_state.get("message"))
        else:
            print("Bad device state:", state_data)

    except Exception as e:
        print("Loop error:", e)
        gc.collect()

    time.sleep(POLL_INTERVAL)

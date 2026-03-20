# Guardian ESP-IDF Scaffold

This folder is the starting point for moving Guardian device firmware from
MicroPython to ESP-IDF.

Why this exists:
- The Cloudflare Worker, mailbox, claim-code onboarding, and dashboard flows are
  already in good shape.
- BLE onboarding is the missing piece for a commercial setup experience.
- MicroPython on this ESP32-C3 is crashing inside the native BLE stack even on
  "advertise only" tests, so BLE provisioning should move to native firmware.

## Product Goal

The final device flow should look like this:

1. Device boots and loads saved state from NVS.
2. If Wi-Fi is not configured, device starts BLE provisioning.
3. Phone or website sends Wi-Fi credentials over BLE.
4. Device joins Wi-Fi.
5. Device POSTs to `/device/bootstrap`.
6. Worker returns either:
   - `claimed: true` with `device_id` and `device_token`, or
   - `claim_code` and `claim_url`
7. User claims the device in Guardian.
8. Device polls bootstrap again, receives `device_id` and `device_token`, and
   stores them in NVS.
9. Device enters runtime mode:
   - `GET /heartbeat` every ~15 seconds
   - `GET /mailbox` every ~5 seconds
   - use mailbox values like `glucose_low`, `glucose_high`, `current_glucose`,
     `predicted_far`, `message`, and future robot commands

## Current Worker Contract

These routes already exist in [worker.js](C:/Users/bradl/OneDrive/Guardian%20Project/GUARDIAN/worker.js):

- `POST /device/bootstrap`
- `POST /device/claim`
- `GET /heartbeat`
- `GET /status`
- `GET /mailbox`
- `POST /mailbox`

The device-side firmware only needs a subset:

- `POST /device/bootstrap`
- `GET /heartbeat`
- `GET /mailbox`

The website handles:

- `POST /device/claim`
- customer login/session
- mailbox writes

## Recommended Firmware Modules

This scaffold keeps the implementation split into a few clean areas:

- `main.c`
  The startup orchestration and state machine entry point.
- `guard_config.h`
  All backend route strings, polling intervals, and provisioning constants.
- `guard_storage.c/.h` (next step)
  NVS read/write helpers for hardware identity, bootstrap secret, Wi-Fi, and
  device credentials.
- `guard_provisioning_ble.c/.h` (next step)
  BLE Wi-Fi provisioning built on ESP-IDF's provisioning manager.
- `guard_cloud.c/.h` (next step)
  HTTPS client calls to `/device/bootstrap`, `/heartbeat`, and `/mailbox`.
- `guard_runtime.c/.h` (next step)
  FreeRTOS tasks for heartbeat, mailbox sync, and robot command execution.

## Suggested Build Order

1. Bring up a minimal bootable ESP-IDF app.
2. Add NVS-backed device identity:
   - `hardware_id`
   - `bootstrap_secret`
3. Add BLE Wi-Fi provisioning using ESP-IDF's provisioning manager.
4. Add `POST /device/bootstrap`.
5. Store `device_id` and `device_token`.
6. Add `GET /heartbeat`.
7. Add `GET /mailbox`.
8. Connect mailbox values to actual robot hardware behavior.

## Suggested State Machine

Use one clear top-level state machine:

- `GUARD_STATE_BOOT`
- `GUARD_STATE_LOAD_STORAGE`
- `GUARD_STATE_WAIT_FOR_WIFI`
- `GUARD_STATE_BOOTSTRAP_DEVICE`
- `GUARD_STATE_WAIT_FOR_CLAIM`
- `GUARD_STATE_RUNTIME`
- `GUARD_STATE_ERROR`

This is easier to debug than spreading onboarding logic across unrelated tasks.

## BLE Recommendation

Use native ESP-IDF Wi-Fi provisioning over BLE rather than building a custom BLE
protocol from scratch first. ESP-IDF already provides a supported provisioning
stack and security model. Once that works reliably, you can layer on extra
Guardian-specific status or claim-code UX if needed.

Useful official docs:

- ESP-IDF Wi-Fi provisioning:
  [docs.espressif.com](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/provisioning/wifi_provisioning.html)
- ESP-IDF HTTP client:
  [docs.espressif.com](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/protocols/esp_http_client.html)
- ESP-IDF NVS:
  [docs.espressif.com](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_flash.html)

## Immediate Next Step

The next implementation pass should add:

- `guard_storage.c/.h`
- `guard_cloud.c/.h`
- `guard_provisioning_ble.c/.h`

with a first milestone of:

- BLE provisioning succeeds
- device joins Wi-Fi
- device can print the JSON returned by `POST /device/bootstrap`

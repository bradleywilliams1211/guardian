#ifndef GUARD_CONFIG_H
#define GUARD_CONFIG_H

// Central place for the Guardian backend contract.
// Keeping route strings and timing together makes it easier to line firmware up
// with the Worker and avoid "one file still points to the old route" bugs.

#define GUARD_WORKER_BASE_URL "https://getguardian.org"

#define GUARD_ROUTE_DEVICE_BOOTSTRAP "/device/bootstrap"
#define GUARD_ROUTE_HEARTBEAT "/heartbeat"
#define GUARD_ROUTE_MAILBOX "/mailbox"
#define GUARD_ROUTE_STATUS "/status"

#define GUARD_HTTP_TIMEOUT_MS 15000
#define GUARD_HTTP_BUFFER_SIZE 4096
#define GUARD_WIFI_CONNECT_TIMEOUT_MS 30000
#define GUARD_WIFI_CONNECT_ATTEMPT_MS 20000
#define GUARD_WIFI_PREFERRED_SCAN_INTERVAL_MS 120000
#define GUARD_BOOTSTRAP_RETRY_MS 10000
#define GUARD_BOOTSTRAP_FAILURES_BEFORE_REPROVISION 3
#define GUARD_HEARTBEAT_INTERVAL_MS 15000
#define GUARD_MAILBOX_INTERVAL_MS 3000
#define GUARD_MAX_SAVED_WIFI_NETWORKS 6
#define GUARD_WIFI_SSID_MAX_LEN 32
#define GUARD_WIFI_PASS_MAX_LEN 64

#define GUARD_PROVISIONING_SERVICE_NAME_PREFIX "GUARD"

// Optional development-only Wi-Fi override.
// Leave these empty in source control for normal BLE provisioning flows.
#define GUARD_DEV_WIFI_SSID ""
#define GUARD_DEV_WIFI_PASS ""

// NVS namespaces and keys. These should stay short and stable because they
// become part of the device's persistent storage layout.
#define GUARD_NVS_NS_DEVICE "guarddev"
#define GUARD_NVS_KEY_HW_ID "hw_id"
#define GUARD_NVS_KEY_BOOT_SECRET "boot_secret"
#define GUARD_NVS_KEY_DEVICE_ID "device_id"
#define GUARD_NVS_KEY_DEVICE_TOKEN "device_token"
#define GUARD_NVS_KEY_WIFI_LIST "wifi_list"
#define GUARD_NVS_KEY_FORCE_BLE "force_ble"
#define GUARD_NVS_KEY_LAST_BLE_CMD "last_ble_cmd"

typedef enum {
    GUARD_STATE_BOOT = 0,
    GUARD_STATE_LOAD_STORAGE,
    GUARD_STATE_WAIT_FOR_WIFI,
    GUARD_STATE_BOOTSTRAP_DEVICE,
    GUARD_STATE_WAIT_FOR_CLAIM,
    GUARD_STATE_RUNTIME,
    GUARD_STATE_ERROR,
} guard_state_t;

typedef struct {
    char hardware_id[64];
    char bootstrap_secret[64];
    char device_id[64];
    char device_token[128];
    char claim_code[32];
    char claim_url[128];
    bool has_wifi_credentials;
    bool is_claimed;
    int64_t last_heartbeat_ms;
    int64_t last_mailbox_updated_at_ms;
} guard_device_context_t;

#endif

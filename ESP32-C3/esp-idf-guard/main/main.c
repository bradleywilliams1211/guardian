#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

#include "guard_config.h"
#include "guard_robot_arduino.h"

static const char *TAG = "guardian";
static const int WIFI_CONNECTED_BIT = BIT0;
static const int PROV_ENDED_BIT = BIT1;
static const char *GUARD_PROV_POP = "guardian-setup";

static EventGroupHandle_t s_guard_event_group;
static bool s_wifi_started = false;
static int s_bootstrap_failures = 0;
static int s_saved_wifi_failures = 0;
static bool s_provisioning_active = false;
static bool s_runtime_wifi_retry_enabled = false;

typedef struct {
    char body[GUARD_HTTP_BUFFER_SIZE];
    size_t len;
    int status_code;
    bool overflowed;
} guard_http_response_t;

static guard_device_context_t g_ctx = {
    .hardware_id = "",
    .bootstrap_secret = "",
    .device_id = "",
    .device_token = "",
    .claim_code = "",
    .claim_url = "",
    .has_wifi_credentials = false,
    .is_claimed = false,
    .last_heartbeat_ms = 0,
    .last_mailbox_updated_at_ms = 0,
};

typedef struct {
    char ssid[GUARD_WIFI_SSID_MAX_LEN + 1];
    char password[GUARD_WIFI_PASS_MAX_LEN + 1];
} guard_saved_wifi_network_t;

typedef struct {
    uint32_t version;
    uint8_t count;
    uint8_t reserved[3];
    guard_saved_wifi_network_t networks[GUARD_MAX_SAVED_WIFI_NETWORKS];
} guard_saved_wifi_store_t;

static guard_saved_wifi_store_t s_saved_wifi_store = {0};
static int s_requested_wifi_network_index = -1;
static int s_current_wifi_network_index = -1;
static int64_t s_last_preferred_wifi_scan_ms = 0;
static char s_pending_provision_ssid[GUARD_WIFI_SSID_MAX_LEN + 1] = "";
static char s_pending_provision_password[GUARD_WIFI_PASS_MAX_LEN + 1] = "";
static bool s_force_ble_reprovision = false;
static char s_last_ble_reprovision_command[64] = "";

static esp_err_t guard_wait_for_wifi_if_needed(void);
static esp_err_t guard_resume_wifi_from_saved_credentials(void);
static bool guard_mailbox_control_matches_last_command(const char *command_id);
static void guard_request_ble_reprovision_restart(const char *command_id);
static void guard_request_factory_reset_restart(const char *command_id);
static void guard_factory_reset_task(void *arg);

static void guard_copy_string(char *dest, size_t dest_len, const char *src) {
    if (!dest || dest_len == 0) {
        return;
    }

    snprintf(dest, dest_len, "%s", src ? src : "");
}

static bool guard_json_copy_string(cJSON *parent, const char *key, char *dest, size_t dest_len) {
    cJSON *item = cJSON_GetObjectItemCaseSensitive(parent, key);
    if (!cJSON_IsString(item) || !item->valuestring) {
        return false;
    }

    guard_copy_string(dest, dest_len, item->valuestring);
    return true;
}

static void guard_describe_json_value(const cJSON *item, char *out, size_t out_len) {
    if (!out || out_len == 0) {
        return;
    }

    if (!item) {
        snprintf(out, out_len, "-");
        return;
    }

    if (cJSON_IsString(item) && item->valuestring) {
        snprintf(out, out_len, "%s", item->valuestring);
        return;
    }

    if (cJSON_IsBool(item)) {
        snprintf(out, out_len, "%s", cJSON_IsTrue(item) ? "true" : "false");
        return;
    }

    if (cJSON_IsNumber(item)) {
        double value = cJSON_GetNumberValue(item);
        if ((double)(int64_t)value == value) {
            snprintf(out, out_len, "%lld", (long long)value);
        } else {
            snprintf(out, out_len, "%.2f", value);
        }
        return;
    }

    if (cJSON_IsNull(item)) {
        snprintf(out, out_len, "null");
        return;
    }

    snprintf(out, out_len, "(complex)");
}

static bool guard_is_wifi_connected(void) {
    if (!s_guard_event_group) {
        return false;
    }

    EventBits_t bits = xEventGroupGetBits(s_guard_event_group);
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

static const char *guard_wifi_disconnect_reason_text(uint8_t reason) {
    switch (reason) {
        case WIFI_REASON_AUTH_EXPIRE: return "auth expired";
        case WIFI_REASON_AUTH_FAIL: return "authentication failed";
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "handshake timeout";
        case WIFI_REASON_HANDSHAKE_TIMEOUT: return "handshake timeout";
        case WIFI_REASON_NO_AP_FOUND: return "network not found";
        case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "network found but security incompatible";
        case WIFI_REASON_ASSOC_FAIL: return "association failed";
        case WIFI_REASON_CONNECTION_FAIL: return "connection failed";
        case WIFI_REASON_BEACON_TIMEOUT: return "beacon timeout";
        case WIFI_REASON_ROAMING: return "roaming";
        default: return "unknown";
    }
}

// HTTP responses can be several kilobytes long, so keeping them off the main
// task stack avoids stack-protection crashes during bootstrap/runtime polling.
static guard_http_response_t *guard_http_response_new(void) {
    return (guard_http_response_t *)calloc(1, sizeof(guard_http_response_t));
}

static void guard_http_response_free(guard_http_response_t *response) {
    free(response);
}

static esp_err_t guard_open_device_nvs(nvs_open_mode_t mode, nvs_handle_t *out_handle) {
    return nvs_open(GUARD_NVS_NS_DEVICE, mode, out_handle);
}

static esp_err_t guard_nvs_load_string(nvs_handle_t handle, const char *key, char *out, size_t out_len) {
    size_t needed = 0;
    esp_err_t err = nvs_get_str(handle, key, NULL, &needed);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        if (out && out_len > 0) {
            out[0] = '\0';
        }
        return err;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs_get_str size failed for key %s", key);

    if (needed > out_len) {
        return ESP_ERR_NVS_INVALID_LENGTH;
    }

    size_t len = out_len;
    return nvs_get_str(handle, key, out, &len);
}

static esp_err_t guard_nvs_commit_and_close(nvs_handle_t handle, esp_err_t err) {
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static void guard_generate_bootstrap_secret(char *out, size_t out_len) {
    uint8_t random_bytes[16] = {0};
    esp_fill_random(random_bytes, sizeof(random_bytes));

    if (!out || out_len == 0) {
        return;
    }

    for (size_t i = 0; i < sizeof(random_bytes) && ((i * 2) + 1) < out_len; i++) {
        snprintf(&out[i * 2], out_len - (i * 2), "%02x", random_bytes[i]);
    }
}

static esp_err_t guard_clear_claimed_credentials(guard_device_context_t *ctx) {
    nvs_handle_t handle;
    esp_err_t err = guard_open_device_nvs(NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not open NVS to clear credentials");

    esp_err_t erase_device_id = nvs_erase_key(handle, GUARD_NVS_KEY_DEVICE_ID);
    esp_err_t erase_device_token = nvs_erase_key(handle, GUARD_NVS_KEY_DEVICE_TOKEN);

    if (erase_device_id != ESP_OK && erase_device_id != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        return erase_device_id;
    }

    if (erase_device_token != ESP_OK && erase_device_token != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(handle);
        return erase_device_token;
    }

    err = guard_nvs_commit_and_close(handle, ESP_OK);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not commit cleared credentials");

    if (ctx) {
        ctx->device_id[0] = '\0';
        ctx->device_token[0] = '\0';
        ctx->is_claimed = false;
        ctx->last_heartbeat_ms = 0;
        ctx->last_mailbox_updated_at_ms = 0;
    }

    return ESP_OK;
}

static esp_err_t guard_store_claimed_credentials(guard_device_context_t *ctx) {
    nvs_handle_t handle;
    esp_err_t err = guard_open_device_nvs(NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not open NVS to store device credentials");

    err = nvs_set_str(handle, GUARD_NVS_KEY_DEVICE_ID, ctx->device_id);
    if (err == ESP_OK) {
        err = nvs_set_str(handle, GUARD_NVS_KEY_DEVICE_TOKEN, ctx->device_token);
    }

    err = guard_nvs_commit_and_close(handle, err);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not commit stored device credentials");

    return ESP_OK;
}

static void guard_saved_wifi_store_reset(guard_saved_wifi_store_t *store) {
    if (!store) {
        return;
    }

    memset(store, 0, sizeof(*store));
    store->version = 1;
}

static bool guard_saved_wifi_entry_valid(const guard_saved_wifi_network_t *entry) {
    return entry && entry->ssid[0] != '\0';
}

static void guard_saved_wifi_store_compact(guard_saved_wifi_store_t *store) {
    if (!store) {
        return;
    }

    guard_saved_wifi_store_t clean = {0};
    clean.version = 1;

    for (size_t i = 0; i < GUARD_MAX_SAVED_WIFI_NETWORKS; i++) {
        if (!guard_saved_wifi_entry_valid(&store->networks[i])) {
            continue;
        }

        if (clean.count >= GUARD_MAX_SAVED_WIFI_NETWORKS) {
            break;
        }

        clean.networks[clean.count++] = store->networks[i];
    }

    *store = clean;
}

static bool guard_saved_wifi_store_has_entries(const guard_saved_wifi_store_t *store) {
    return store && store->count > 0 && guard_saved_wifi_entry_valid(&store->networks[0]);
}

static int guard_saved_wifi_store_find_index(const guard_saved_wifi_store_t *store, const char *ssid) {
    if (!guard_saved_wifi_store_has_entries(store) || !ssid || ssid[0] == '\0') {
        return -1;
    }

    for (int i = 0; i < (int)store->count; i++) {
        if (strcmp(store->networks[i].ssid, ssid) == 0) {
            return i;
        }
    }

    return -1;
}

static esp_err_t guard_load_saved_wifi_store(guard_saved_wifi_store_t *store) {
    nvs_handle_t handle;
    size_t blob_len = sizeof(*store);
    esp_err_t err;

    ESP_RETURN_ON_FALSE(store != NULL, ESP_ERR_INVALID_ARG, TAG, "saved wifi store is required");
    guard_saved_wifi_store_reset(store);

    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READONLY, &handle), TAG, "Could not open NVS for saved Wi-Fi load");
    err = nvs_get_blob(handle, GUARD_NVS_KEY_WIFI_LIST, store, &blob_len);
    nvs_close(handle);

    if (err == ESP_ERR_NVS_NOT_FOUND) {
        guard_saved_wifi_store_reset(store);
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(err, TAG, "Could not load saved Wi-Fi list");

    if (blob_len != sizeof(*store) || store->version != 1 || store->count > GUARD_MAX_SAVED_WIFI_NETWORKS) {
        ESP_LOGW(TAG, "Saved Wi-Fi list format was invalid. Resetting it.");
        guard_saved_wifi_store_reset(store);
        return ESP_OK;
    }

    guard_saved_wifi_store_compact(store);
    return ESP_OK;
}

static esp_err_t guard_save_saved_wifi_store(const guard_saved_wifi_store_t *store) {
    nvs_handle_t handle;
    esp_err_t err;

    ESP_RETURN_ON_FALSE(store != NULL, ESP_ERR_INVALID_ARG, TAG, "saved wifi store is required");
    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READWRITE, &handle), TAG, "Could not open NVS for saved Wi-Fi save");

    err = nvs_set_blob(handle, GUARD_NVS_KEY_WIFI_LIST, store, sizeof(*store));
    err = guard_nvs_commit_and_close(handle, err);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not save Wi-Fi list");
    return ESP_OK;
}

static esp_err_t guard_load_force_ble_reprovision_flag(bool *out_flag) {
    nvs_handle_t handle;
    uint8_t value = 0;
    esp_err_t err;

    ESP_RETURN_ON_FALSE(out_flag != NULL, ESP_ERR_INVALID_ARG, TAG, "force ble output flag is required");
    *out_flag = false;

    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READONLY, &handle), TAG, "Could not open NVS for force BLE flag");
    err = nvs_get_u8(handle, GUARD_NVS_KEY_FORCE_BLE, &value);
    nvs_close(handle);

    if (err == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(err, TAG, "Could not load force BLE flag");
    *out_flag = value != 0;
    return ESP_OK;
}

static esp_err_t guard_set_force_ble_reprovision_flag(bool enabled) {
    nvs_handle_t handle;
    esp_err_t err;

    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READWRITE, &handle), TAG, "Could not open NVS for force BLE flag");
    err = nvs_set_u8(handle, GUARD_NVS_KEY_FORCE_BLE, enabled ? 1 : 0);
    err = guard_nvs_commit_and_close(handle, err);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not save force BLE flag");
    s_force_ble_reprovision = enabled;
    return ESP_OK;
}

static esp_err_t guard_load_last_ble_reprovision_command(char *out, size_t out_len) {
    nvs_handle_t handle;
    esp_err_t err;

    ESP_RETURN_ON_FALSE(out != NULL && out_len > 0, ESP_ERR_INVALID_ARG, TAG, "last BLE command buffer is required");
    out[0] = '\0';

    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READONLY, &handle), TAG, "Could not open NVS for BLE command load");
    err = guard_nvs_load_string(handle, GUARD_NVS_KEY_LAST_BLE_CMD, out, out_len);
    nvs_close(handle);

    if (err == ESP_ERR_NVS_NOT_FOUND) {
        out[0] = '\0';
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(err, TAG, "Could not load last BLE command");
    return ESP_OK;
}

static esp_err_t guard_store_last_ble_reprovision_command(const char *command_id) {
    nvs_handle_t handle;
    esp_err_t err;

    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READWRITE, &handle), TAG, "Could not open NVS for BLE command save");
    err = nvs_set_str(handle, GUARD_NVS_KEY_LAST_BLE_CMD, command_id ? command_id : "");
    err = guard_nvs_commit_and_close(handle, err);
    ESP_RETURN_ON_ERROR(err, TAG, "Could not save last BLE command");
    guard_copy_string(s_last_ble_reprovision_command, sizeof(s_last_ble_reprovision_command), command_id);
    return ESP_OK;
}

static esp_err_t guard_upsert_saved_wifi_network(const char *ssid, const char *password, bool make_preferred) {
    guard_saved_wifi_store_t store = s_saved_wifi_store;
    guard_saved_wifi_network_t entry = {0};
    int existing_index;

    ESP_RETURN_ON_FALSE(ssid != NULL && ssid[0] != '\0', ESP_ERR_INVALID_ARG, TAG, "Wi-Fi SSID is required");

    guard_copy_string(entry.ssid, sizeof(entry.ssid), ssid);
    guard_copy_string(entry.password, sizeof(entry.password), password ? password : "");

    existing_index = guard_saved_wifi_store_find_index(&store, entry.ssid);
    if (existing_index >= 0) {
        store.networks[existing_index] = entry;
    } else if (store.count < GUARD_MAX_SAVED_WIFI_NETWORKS) {
        store.networks[store.count] = entry;
        existing_index = (int)store.count;
        store.count++;
    } else {
        existing_index = GUARD_MAX_SAVED_WIFI_NETWORKS - 1;
        store.networks[existing_index] = entry;
    }

    if (make_preferred && existing_index > 0) {
        guard_saved_wifi_network_t promoted = store.networks[existing_index];
        for (int i = existing_index; i > 0; i--) {
            store.networks[i] = store.networks[i - 1];
        }
        store.networks[0] = promoted;
    }

    guard_saved_wifi_store_compact(&store);
    ESP_RETURN_ON_ERROR(guard_save_saved_wifi_store(&store), TAG, "Could not commit updated Wi-Fi list");
    s_saved_wifi_store = store;

    ESP_LOGI(
        TAG,
        "Saved Wi-Fi network %s%s (%d stored)",
        entry.ssid,
        make_preferred ? " as preferred" : "",
        (int)s_saved_wifi_store.count
    );
    return ESP_OK;
}

static void guard_clear_pending_provision_credentials(void) {
    s_pending_provision_ssid[0] = '\0';
    s_pending_provision_password[0] = '\0';
}

static void guard_remember_provision_credentials(const wifi_sta_config_t *wifi_sta_cfg) {
    if (!wifi_sta_cfg) {
        guard_clear_pending_provision_credentials();
        return;
    }

    guard_copy_string(s_pending_provision_ssid, sizeof(s_pending_provision_ssid), (const char *)wifi_sta_cfg->ssid);
    guard_copy_string(s_pending_provision_password, sizeof(s_pending_provision_password), (const char *)wifi_sta_cfg->password);
}

static void guard_log_saved_wifi_summary(void) {
    if (!guard_saved_wifi_store_has_entries(&s_saved_wifi_store)) {
        ESP_LOGI(TAG, "Saved Wi-Fi list is empty");
        return;
    }

    ESP_LOGI(
        TAG,
        "Saved Wi-Fi networks: preferred=%s total=%d",
        s_saved_wifi_store.networks[0].ssid,
        (int)s_saved_wifi_store.count
    );
}

static esp_err_t guard_build_device_info_json(char *response, size_t response_len) {
    const char *preferred_ssid = guard_saved_wifi_store_has_entries(&s_saved_wifi_store)
        ? s_saved_wifi_store.networks[0].ssid
        : "";

    int written = snprintf(
        response,
        response_len,
        "{\"hardware_id\":\"%s\",\"device_id\":\"%s\",\"claimed\":%s,\"saved_wifi_count\":%d,\"preferred_wifi_ssid\":\"%s\"}",
        g_ctx.hardware_id,
        g_ctx.device_id,
        g_ctx.is_claimed ? "true" : "false",
        (int)s_saved_wifi_store.count,
        preferred_ssid
    );

    return (written > 0 && (size_t)written < response_len) ? ESP_OK : ESP_ERR_NO_MEM;
}

static esp_err_t guard_custom_prov_data_handler(
    uint32_t session_id,
    const uint8_t *inbuf,
    ssize_t inlen,
    uint8_t **outbuf,
    ssize_t *outlen,
    void *priv_data
) {
    (void)session_id;
    (void)priv_data;

    char request_text[384] = {0};
    if (inbuf && inlen > 0) {
        size_t copy_len = (size_t)inlen < sizeof(request_text) - 1 ? (size_t)inlen : sizeof(request_text) - 1;
        memcpy(request_text, inbuf, copy_len);
    }

    char response[512] = {0};
    if (strcmp(request_text, "device-info") == 0 || request_text[0] == '\0') {
        ESP_RETURN_ON_ERROR(guard_build_device_info_json(response, sizeof(response)), TAG, "Could not build device info response");
    } else if (request_text[0] == '{') {
        cJSON *root = cJSON_Parse(request_text);
        const cJSON *type_item = root ? cJSON_GetObjectItemCaseSensitive(root, "type") : NULL;
        const char *type = cJSON_IsString(type_item) ? type_item->valuestring : "";

        if (strcmp(type, "wifi-save") == 0) {
            const cJSON *ssid_item = cJSON_GetObjectItemCaseSensitive(root, "ssid");
            const cJSON *password_item = cJSON_GetObjectItemCaseSensitive(root, "password");
            bool preferred = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "preferred"));

            if (!cJSON_IsString(ssid_item) || !ssid_item->valuestring || ssid_item->valuestring[0] == '\0') {
                snprintf(response, sizeof(response), "{\"ok\":false,\"error\":\"ssid required\"}");
            } else {
                const char *password = (cJSON_IsString(password_item) && password_item->valuestring)
                    ? password_item->valuestring
                    : "";

                esp_err_t save_err = guard_upsert_saved_wifi_network(ssid_item->valuestring, password, preferred);
                if (save_err == ESP_OK) {
                    snprintf(
                        response,
                        sizeof(response),
                        "{\"ok\":true,\"saved\":true,\"saved_wifi_count\":%d,\"preferred_wifi_ssid\":\"%s\"}",
                        (int)s_saved_wifi_store.count,
                        guard_saved_wifi_store_has_entries(&s_saved_wifi_store) ? s_saved_wifi_store.networks[0].ssid : ""
                    );
                } else {
                    snprintf(response, sizeof(response), "{\"ok\":false,\"error\":\"save failed\"}");
                }
            }
        } else if (strcmp(type, "factory-reset") == 0) {
            const cJSON *command_item = cJSON_GetObjectItemCaseSensitive(root, "command_id");
            const char *command_id = (cJSON_IsString(command_item) && command_item->valuestring && command_item->valuestring[0] != '\0')
                ? command_item->valuestring
                : "ble-factory-reset";

            char *task_command = strdup(command_id);
            if (!task_command) {
                snprintf(response, sizeof(response), "{\"ok\":false,\"error\":\"reset allocation failed\"}");
            } else if (xTaskCreate(guard_factory_reset_task, "guard_factory_reset", 4096, task_command, 5, NULL) != pdPASS) {
                free(task_command);
                snprintf(response, sizeof(response), "{\"ok\":false,\"error\":\"reset task failed\"}");
            } else {
                snprintf(response, sizeof(response), "{\"ok\":true,\"resetting\":true}");
            }
        } else if (strcmp(type, "wifi-list") == 0) {
            ESP_RETURN_ON_ERROR(guard_build_device_info_json(response, sizeof(response)), TAG, "Could not build wifi list response");
        } else {
            snprintf(
                response,
                sizeof(response),
                "{\"ok\":false,\"hardware_id\":\"%s\",\"message\":\"unknown request\"}",
                g_ctx.hardware_id
            );
        }

        if (root) {
            cJSON_Delete(root);
        }
    } else {
        snprintf(
            response,
            sizeof(response),
            "{\"hardware_id\":\"%s\",\"message\":\"unknown request\"}",
            g_ctx.hardware_id
        );
    }

    size_t response_len = strlen(response);
    *outbuf = (uint8_t *)malloc(response_len + 1);
    ESP_RETURN_ON_FALSE(*outbuf != NULL, ESP_ERR_NO_MEM, TAG, "Could not allocate custom provisioning response");
    memcpy(*outbuf, response, response_len + 1);
    *outlen = (ssize_t)response_len;
    return ESP_OK;
}

static void guard_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    (void)arg;

    if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
            case WIFI_PROV_START:
                s_provisioning_active = true;
                s_runtime_wifi_retry_enabled = false;
                ESP_LOGI(TAG, "BLE provisioning started");
                break;
            case WIFI_PROV_CRED_RECV: {
                wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
                guard_remember_provision_credentials(wifi_sta_cfg);
                ESP_LOGI(TAG, "Received Wi-Fi credentials for SSID: %s", (const char *)wifi_sta_cfg->ssid);
                break;
            }
            case WIFI_PROV_CRED_FAIL: {
                wifi_prov_sta_fail_reason_t *reason = (wifi_prov_sta_fail_reason_t *)event_data;
                guard_clear_pending_provision_credentials();
                ESP_LOGE(
                    TAG,
                    "Provisioning failed: %s",
                    (*reason == WIFI_PROV_STA_AUTH_ERROR) ? "authentication error" : "access point not found"
                );
                break;
            }
            case WIFI_PROV_CRED_SUCCESS:
                ESP_LOGI(TAG, "Provisioning credentials accepted");
                break;
            case WIFI_PROV_END:
                s_provisioning_active = false;
                ESP_LOGI(TAG, "Provisioning manager finished");
                xEventGroupSetBits(s_guard_event_group, PROV_ENDED_BIT);
                wifi_prov_mgr_deinit();
                break;
            default:
                break;
        }
    } else if (event_base == WIFI_EVENT) {
        switch (event_id) {
            case WIFI_EVENT_STA_START:
                ESP_LOGI(TAG, "Wi-Fi STA started");
                if (s_runtime_wifi_retry_enabled && !s_provisioning_active) {
                    esp_wifi_connect();
                }
                break;
            case WIFI_EVENT_STA_DISCONNECTED:
                if (event_data) {
                    wifi_event_sta_disconnected_t *disconnected = (wifi_event_sta_disconnected_t *)event_data;
                    ESP_LOGW(
                        TAG,
                        "Wi-Fi disconnected (reason %u: %s)",
                        disconnected->reason,
                        guard_wifi_disconnect_reason_text(disconnected->reason)
                    );
                }
                xEventGroupClearBits(s_guard_event_group, WIFI_CONNECTED_BIT);
                if (s_provisioning_active) {
                    ESP_LOGW(TAG, "Wi-Fi disconnected while provisioning; waiting for provisioning manager to retry");
                } else if (s_runtime_wifi_retry_enabled) {
                    ESP_LOGW(TAG, "Wi-Fi disconnected, retrying...");
                    esp_wifi_connect();
                } else {
                    ESP_LOGW(TAG, "Wi-Fi disconnected");
                }
                break;
            default:
                break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected with IP Address: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_guard_event_group, WIFI_CONNECTED_BIT);
        if (s_requested_wifi_network_index >= 0 && s_requested_wifi_network_index < (int)s_saved_wifi_store.count) {
            s_current_wifi_network_index = s_requested_wifi_network_index;
        }
        s_requested_wifi_network_index = -1;

        if (s_pending_provision_ssid[0] != '\0') {
            if (guard_upsert_saved_wifi_network(s_pending_provision_ssid, s_pending_provision_password, true) == ESP_OK) {
                s_current_wifi_network_index = guard_saved_wifi_store_find_index(&s_saved_wifi_store, s_pending_provision_ssid);
                guard_log_saved_wifi_summary();
            }
            guard_clear_pending_provision_credentials();
        } else if (!guard_saved_wifi_store_has_entries(&s_saved_wifi_store)) {
            wifi_config_t wifi_config = {0};
            if (esp_wifi_get_config(WIFI_IF_STA, &wifi_config) == ESP_OK && wifi_config.sta.ssid[0] != '\0') {
                if (guard_upsert_saved_wifi_network((const char *)wifi_config.sta.ssid, (const char *)wifi_config.sta.password, true) == ESP_OK) {
                    s_current_wifi_network_index = 0;
                    ESP_LOGI(TAG, "Adopted current Wi-Fi %s into GUARD's saved network list", (const char *)wifi_config.sta.ssid);
                }
            }
        }

        if (s_force_ble_reprovision) {
            (void)guard_set_force_ble_reprovision_flag(false);
            ESP_LOGI(TAG, "Forced Bluetooth reprovision mode is complete.");
        }
    } else if (event_base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
        switch (event_id) {
            case PROTOCOMM_TRANSPORT_BLE_CONNECTED:
                ESP_LOGI(TAG, "BLE transport connected");
                break;
            case PROTOCOMM_TRANSPORT_BLE_DISCONNECTED:
                ESP_LOGI(TAG, "BLE transport disconnected");
                break;
            default:
                break;
        }
    }
}

static void guard_register_event_handlers(void) {
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &guard_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID, &guard_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &guard_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &guard_event_handler, NULL));
}

static void guard_wifi_init(void) {
    s_guard_event_group = xEventGroupCreate();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
}

static esp_err_t guard_wait_for_wifi_timeout(uint32_t timeout_ms) {
    if (guard_is_wifi_connected()) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    EventBits_t bits = xEventGroupWaitBits(
        s_guard_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdTRUE,
        pdMS_TO_TICKS(timeout_ms)
    );

    if (bits & WIFI_CONNECTED_BIT) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    return ESP_ERR_TIMEOUT;
}

static esp_err_t guard_start_wifi_station(void) {
    s_runtime_wifi_retry_enabled = true;
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "esp_wifi_set_mode failed");

    if (!s_wifi_started) {
        ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");
        s_wifi_started = true;
        return ESP_OK;
    }

    return esp_wifi_connect();
}

static esp_err_t guard_connect_saved_wifi_network(int index) {
    wifi_config_t wifi_config = {0};
    const guard_saved_wifi_network_t *network;

    ESP_RETURN_ON_FALSE(
        index >= 0 && index < (int)s_saved_wifi_store.count,
        ESP_ERR_INVALID_ARG,
        TAG,
        "Saved Wi-Fi index %d is invalid",
        index
    );

    network = &s_saved_wifi_store.networks[index];
    guard_copy_string((char *)wifi_config.sta.ssid, sizeof(wifi_config.sta.ssid), network->ssid);
    guard_copy_string((char *)wifi_config.sta.password, sizeof(wifi_config.sta.password), network->password);
    wifi_config.sta.threshold.authmode = network->password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_RETURN_ON_ERROR(guard_start_wifi_station(), TAG, "Could not start Wi-Fi station");
    (void)esp_wifi_disconnect();
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi_config), TAG, "esp_wifi_set_config failed for saved network");

    s_requested_wifi_network_index = index;
    ESP_LOGI(
        TAG,
        "Trying saved Wi-Fi network %s%s",
        network->ssid,
        index == 0 ? " (preferred)" : ""
    );
    return esp_wifi_connect();
}

static int guard_pick_visible_saved_wifi_index(void) {
    uint16_t ap_count = 0;
    wifi_scan_config_t scan_config = {
        .show_hidden = true,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };

    if (!guard_saved_wifi_store_has_entries(&s_saved_wifi_store)) {
        return -1;
    }

    if (esp_wifi_scan_start(&scan_config, true) != ESP_OK) {
        ESP_LOGW(TAG, "Saved Wi-Fi scan could not start");
        return -1;
    }

    if (esp_wifi_scan_get_ap_num(&ap_count) != ESP_OK || ap_count == 0) {
        return -1;
    }

    wifi_ap_record_t *records = (wifi_ap_record_t *)calloc(ap_count, sizeof(wifi_ap_record_t));
    if (!records) {
        ESP_LOGW(TAG, "Could not allocate Wi-Fi scan records");
        return -1;
    }

    if (esp_wifi_scan_get_ap_records(&ap_count, records) != ESP_OK) {
        free(records);
        return -1;
    }

    for (int i = 0; i < (int)s_saved_wifi_store.count; i++) {
        for (uint16_t j = 0; j < ap_count; j++) {
            if (strcmp((const char *)records[j].ssid, s_saved_wifi_store.networks[i].ssid) == 0) {
                free(records);
                return i;
            }
        }
    }

    free(records);
    return -1;
}

static esp_err_t guard_try_saved_wifi_candidates(void) {
    if (guard_is_wifi_connected()) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    int visible_index = guard_pick_visible_saved_wifi_index();

    if (visible_index >= 0) {
        ESP_RETURN_ON_ERROR(guard_connect_saved_wifi_network(visible_index), TAG, "Could not connect chosen saved network");
        if (guard_wait_for_wifi_timeout(GUARD_WIFI_CONNECT_ATTEMPT_MS) == ESP_OK) {
            return ESP_OK;
        }
    }

    for (int i = 0; i < (int)s_saved_wifi_store.count; i++) {
        if (i == visible_index) {
            continue;
        }

        ESP_RETURN_ON_ERROR(guard_connect_saved_wifi_network(i), TAG, "Could not connect fallback saved network");
        if (guard_wait_for_wifi_timeout(GUARD_WIFI_CONNECT_ATTEMPT_MS) == ESP_OK) {
            return ESP_OK;
        }
    }

    return ESP_ERR_TIMEOUT;
}

static esp_err_t guard_maybe_switch_back_to_preferred_wifi(void) {
    int64_t now_ms;
    int visible_index;

    if (!guard_is_wifi_connected()) {
        return ESP_ERR_INVALID_STATE;
    }

    if (!guard_saved_wifi_store_has_entries(&s_saved_wifi_store) || s_current_wifi_network_index <= 0) {
        return ESP_OK;
    }

    now_ms = esp_timer_get_time() / 1000;
    if ((now_ms - s_last_preferred_wifi_scan_ms) < GUARD_WIFI_PREFERRED_SCAN_INTERVAL_MS) {
        return ESP_OK;
    }
    s_last_preferred_wifi_scan_ms = now_ms;

    visible_index = guard_pick_visible_saved_wifi_index();
    if (visible_index != 0) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Preferred Wi-Fi %s is visible again. Switching back.", s_saved_wifi_store.networks[0].ssid);
    ESP_RETURN_ON_ERROR(guard_connect_saved_wifi_network(0), TAG, "Could not switch back to preferred Wi-Fi");
    return guard_wait_for_wifi_timeout(GUARD_WIFI_CONNECT_ATTEMPT_MS);
}

static bool guard_has_dev_wifi_override(void) {
    return GUARD_DEV_WIFI_SSID[0] != '\0';
}

static esp_err_t guard_apply_dev_wifi_override(void) {
    wifi_config_t wifi_config = {0};

    guard_copy_string((char *)wifi_config.sta.ssid, sizeof(wifi_config.sta.ssid), GUARD_DEV_WIFI_SSID);
    guard_copy_string((char *)wifi_config.sta.password, sizeof(wifi_config.sta.password), GUARD_DEV_WIFI_PASS);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    wifi_config.sta.pmf_cfg.capable = true;
    wifi_config.sta.pmf_cfg.required = false;

    ESP_LOGI(TAG, "Applying local Wi-Fi override for SSID: %s", GUARD_DEV_WIFI_SSID);
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "esp_wifi_set_mode failed for dev Wi-Fi override");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi_config), TAG, "esp_wifi_set_config failed for dev Wi-Fi override");
    (void)guard_upsert_saved_wifi_network(GUARD_DEV_WIFI_SSID, GUARD_DEV_WIFI_PASS, true);

    g_ctx.has_wifi_credentials = true;
    return guard_start_wifi_station();
}

static esp_err_t guard_reset_saved_wifi_provisioning(void) {
    ESP_LOGW(TAG, "Clearing saved Wi-Fi credentials so Bluetooth provisioning can start again");
    esp_err_t err = esp_wifi_restore();
    if (err != ESP_OK && err != ESP_ERR_WIFI_NOT_INIT) {
        return err;
    }

    (void)esp_wifi_disconnect();
    esp_err_t stop_err = esp_wifi_stop();
    if (stop_err != ESP_OK && stop_err != ESP_ERR_WIFI_NOT_STARTED) {
        return stop_err;
    }

    s_wifi_started = false;
    guard_saved_wifi_store_reset(&s_saved_wifi_store);
    ESP_RETURN_ON_ERROR(guard_save_saved_wifi_store(&s_saved_wifi_store), TAG, "Could not clear saved Wi-Fi list");
    g_ctx.has_wifi_credentials = false;
    xEventGroupClearBits(s_guard_event_group, WIFI_CONNECTED_BIT);
    return ESP_OK;
}

static void guard_build_service_name(char *service_name, size_t max_len) {
    uint8_t mac[6] = {0};
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(service_name, max_len, "%s-%02X%02X", GUARD_PROVISIONING_SERVICE_NAME_PREFIX, mac[4], mac[5]);
}

static void guard_log_contract(void) {
    ESP_LOGI(TAG, "Guardian Worker base: %s", GUARD_WORKER_BASE_URL);
    ESP_LOGI(TAG, "Bootstrap route: %s", GUARD_ROUTE_DEVICE_BOOTSTRAP);
    ESP_LOGI(TAG, "Heartbeat route: %s", GUARD_ROUTE_HEARTBEAT);
    ESP_LOGI(TAG, "Mailbox route: %s", GUARD_ROUTE_MAILBOX);
}

static esp_err_t guard_init_platform(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs_flash_init failed");

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif_init failed");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop init failed");
    guard_register_event_handlers();
    guard_wifi_init();

    return ESP_OK;
}

static esp_err_t guard_load_or_create_identity(guard_device_context_t *ctx) {
    nvs_handle_t handle;
    bool should_commit = false;

    ESP_RETURN_ON_FALSE(ctx != NULL, ESP_ERR_INVALID_ARG, TAG, "guard context is required");
    ESP_RETURN_ON_ERROR(guard_open_device_nvs(NVS_READWRITE, &handle), TAG, "Could not open device NVS");

    esp_err_t err = guard_nvs_load_string(handle, GUARD_NVS_KEY_HW_ID, ctx->hardware_id, sizeof(ctx->hardware_id));
    if (err == ESP_ERR_NVS_NOT_FOUND || ctx->hardware_id[0] == '\0') {
        uint8_t mac[6] = {0};
        ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_STA), TAG, "esp_read_mac failed");
        snprintf(
            ctx->hardware_id,
            sizeof(ctx->hardware_id),
            "guard-%02x%02x%02x%02x%02x%02x",
            mac[0],
            mac[1],
            mac[2],
            mac[3],
            mac[4],
            mac[5]
        );
        ESP_RETURN_ON_ERROR(nvs_set_str(handle, GUARD_NVS_KEY_HW_ID, ctx->hardware_id), TAG, "Could not save hardware id");
        should_commit = true;
    } else {
        ESP_RETURN_ON_ERROR(err, TAG, "Could not load saved hardware id");
    }

    err = guard_nvs_load_string(
        handle,
        GUARD_NVS_KEY_BOOT_SECRET,
        ctx->bootstrap_secret,
        sizeof(ctx->bootstrap_secret)
    );
    if (err == ESP_ERR_NVS_NOT_FOUND || ctx->bootstrap_secret[0] == '\0') {
        guard_generate_bootstrap_secret(ctx->bootstrap_secret, sizeof(ctx->bootstrap_secret));
        ESP_RETURN_ON_FALSE(ctx->bootstrap_secret[0] != '\0', ESP_FAIL, TAG, "Bootstrap secret generation failed");
        ESP_RETURN_ON_ERROR(
            nvs_set_str(handle, GUARD_NVS_KEY_BOOT_SECRET, ctx->bootstrap_secret),
            TAG,
            "Could not save bootstrap secret"
        );
        should_commit = true;
    } else {
        ESP_RETURN_ON_ERROR(err, TAG, "Could not load saved bootstrap secret");
    }

    err = guard_nvs_load_string(handle, GUARD_NVS_KEY_DEVICE_ID, ctx->device_id, sizeof(ctx->device_id));
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_RETURN_ON_ERROR(err, TAG, "Could not load saved device id");
    }

    err = guard_nvs_load_string(handle, GUARD_NVS_KEY_DEVICE_TOKEN, ctx->device_token, sizeof(ctx->device_token));
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_RETURN_ON_ERROR(err, TAG, "Could not load saved device token");
    }

    ctx->is_claimed = (ctx->device_id[0] != '\0' && ctx->device_token[0] != '\0');
    ctx->last_heartbeat_ms = 0;
    ctx->last_mailbox_updated_at_ms = 0;
    ESP_RETURN_ON_ERROR(guard_load_saved_wifi_store(&s_saved_wifi_store), TAG, "Could not load saved Wi-Fi list");
    ESP_RETURN_ON_ERROR(guard_load_force_ble_reprovision_flag(&s_force_ble_reprovision), TAG, "Could not load force BLE flag");
    ESP_RETURN_ON_ERROR(
        guard_load_last_ble_reprovision_command(
            s_last_ble_reprovision_command,
            sizeof(s_last_ble_reprovision_command)
        ),
        TAG,
        "Could not load last BLE reprovision command"
    );
    ctx->has_wifi_credentials = guard_saved_wifi_store_has_entries(&s_saved_wifi_store);
    s_current_wifi_network_index = -1;
    s_requested_wifi_network_index = -1;

    if (should_commit) {
        ESP_RETURN_ON_ERROR(nvs_commit(handle), TAG, "Could not commit device identity");
    }

    nvs_close(handle);

    ESP_LOGI(TAG, "Loaded device identity: %s", ctx->hardware_id);
    if (ctx->is_claimed) {
        ESP_LOGI(TAG, "Loaded saved claimed credentials for device %s", ctx->device_id);
    }
    guard_log_saved_wifi_summary();
    if (s_force_ble_reprovision) {
        ESP_LOGW(TAG, "GUARD will re-enter Bluetooth provisioning on this boot.");
    }

    return ESP_OK;
}

static esp_err_t guard_start_ble_provisioning(void) {
    bool provisioned = false;
    char service_name[16] = {0};
    const wifi_prov_security_t security = WIFI_PROV_SECURITY_1;
    const char *service_key = NULL;
    const char *pop = GUARD_PROV_POP;

    wifi_prov_mgr_config_t config = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };

    ESP_ERROR_CHECK(wifi_prov_mgr_init(config));

    ESP_ERROR_CHECK(wifi_prov_mgr_is_provisioned(&provisioned));

    if (guard_has_dev_wifi_override()) {
        ESP_LOGI(TAG, "Using local development Wi-Fi override instead of Bluetooth provisioning");
        wifi_prov_mgr_deinit();
        return guard_apply_dev_wifi_override();
    }

    if (provisioned && !s_force_ble_reprovision) {
        ESP_LOGI(TAG, "Wi-Fi is already provisioned, resuming saved station credentials");
        wifi_prov_mgr_deinit();
        g_ctx.has_wifi_credentials = true;
        return guard_resume_wifi_from_saved_credentials();
    }

    if (s_force_ble_reprovision) {
        ESP_LOGW(TAG, "Forced Bluetooth reprovision mode requested. Starting BLE setup without clearing saved networks.");
        xEventGroupClearBits(s_guard_event_group, WIFI_CONNECTED_BIT);
        s_runtime_wifi_retry_enabled = false;
        (void)esp_wifi_disconnect();
        if (s_wifi_started) {
            (void)esp_wifi_stop();
            s_wifi_started = false;
        }
    }

    s_runtime_wifi_retry_enabled = false;
    guard_build_service_name(service_name, sizeof(service_name));
    ESP_LOGI(TAG, "Starting Guardian BLE provisioning as %s", service_name);
    ESP_LOGI(TAG, "Proof of possession: %s", pop);

    uint8_t custom_service_uuid[] = {
        0xb4, 0xdf, 0x5a, 0x1c, 0x3f, 0x6b, 0xf4, 0xbf,
        0xea, 0x4a, 0x82, 0x03, 0x04, 0x90, 0x1a, 0x02,
    };
    wifi_prov_scheme_ble_set_service_uuid(custom_service_uuid);

    ESP_ERROR_CHECK(wifi_prov_mgr_endpoint_create("custom-data"));
    ESP_ERROR_CHECK(wifi_prov_mgr_start_provisioning(security, pop, service_name, service_key));
    ESP_ERROR_CHECK(wifi_prov_mgr_endpoint_register("custom-data", guard_custom_prov_data_handler, NULL));
    guard_robot_show_setup_message("Bluetooth Setup", service_name);

    ESP_LOGI(TAG, "Waiting for Guardian to send Wi-Fi credentials over Bluetooth.");

    EventBits_t bits = xEventGroupWaitBits(
        s_guard_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdTRUE,
        portMAX_DELAY
    );

    if (bits & WIFI_CONNECTED_BIT) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    return ESP_FAIL;
}

static esp_err_t guard_wait_for_wifi_if_needed(void) {
    return guard_wait_for_wifi_timeout(GUARD_WIFI_CONNECT_TIMEOUT_MS);
}

static void guard_log_ble_provisioning_help(void) {
    char service_name[16] = {0};
    guard_build_service_name(service_name, sizeof(service_name));

    ESP_LOGI(TAG, "Guardian BLE provisioning helper");
    ESP_LOGI(TAG, "Service name: %s", service_name);
    ESP_LOGI(TAG, "PoP: %s", GUARD_PROV_POP);
    ESP_LOGI(
        TAG,
        "Developer CLI example: python %s\\tools\\esp_prov\\esp_prov.py --transport ble --service_name %s --sec_ver 1 --pop %s --ssid <wifi> --passphrase <password>",
        "%%IDF_PATH%%",
        service_name,
        GUARD_PROV_POP
    );
}

static esp_err_t guard_resume_wifi_from_saved_credentials(void) {
    ESP_LOGI(TAG, "Trying saved Wi-Fi credentials");
    if (guard_is_wifi_connected()) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    if (guard_saved_wifi_store_has_entries(&s_saved_wifi_store)) {
        return guard_try_saved_wifi_candidates();
    }

    ESP_RETURN_ON_ERROR(guard_start_wifi_station(), TAG, "Could not start Wi-Fi station");
    return guard_wait_for_wifi_if_needed();
}

static esp_err_t guard_http_event_handler(esp_http_client_event_t *evt) {
    guard_http_response_t *response = (guard_http_response_t *)evt->user_data;
    if (!response) {
        return ESP_OK;
    }

    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data && evt->data_len > 0) {
        size_t remaining = sizeof(response->body) - response->len - 1;
        size_t to_copy = evt->data_len < (int)remaining ? (size_t)evt->data_len : remaining;

        if (to_copy > 0) {
            memcpy(&response->body[response->len], evt->data, to_copy);
            response->len += to_copy;
            response->body[response->len] = '\0';
        }

        if (to_copy < (size_t)evt->data_len) {
            response->overflowed = true;
        }
    }

    return ESP_OK;
}

static void guard_build_route_url(const char *route, char *out, size_t out_len) {
    snprintf(out, out_len, "%s%s", GUARD_WORKER_BASE_URL, route);
}

static void guard_build_device_route_url(const char *route, const char *device_id, char *out, size_t out_len) {
    snprintf(out, out_len, "%s%s?device_id=%s", GUARD_WORKER_BASE_URL, route, device_id);
}

static esp_err_t guard_http_request(
    esp_http_client_method_t method,
    const char *url,
    const char *body,
    const char *device_id,
    const char *device_token,
    guard_http_response_t *response
) {
    ESP_RETURN_ON_FALSE(url != NULL, ESP_ERR_INVALID_ARG, TAG, "HTTP URL is required");
    ESP_RETURN_ON_FALSE(response != NULL, ESP_ERR_INVALID_ARG, TAG, "HTTP response storage is required");

    memset(response, 0, sizeof(*response));

    esp_http_client_config_t config = {
        .url = url,
        .method = method,
        .timeout_ms = GUARD_HTTP_TIMEOUT_MS,
        .transport_type = HTTP_TRANSPORT_OVER_SSL,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = guard_http_event_handler,
        .user_data = response,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    ESP_RETURN_ON_FALSE(client != NULL, ESP_FAIL, TAG, "Could not create HTTP client");

    esp_http_client_set_header(client, "Accept", "application/json");
    esp_http_client_set_header(client, "User-Agent", "GUARDIAN-IDF/1.0");

    if (device_id && device_id[0] != '\0') {
        esp_http_client_set_header(client, "x-device-id", device_id);
    }

    if (device_token && device_token[0] != '\0') {
        esp_http_client_set_header(client, "x-device-token", device_token);
    }

    if (body) {
        esp_http_client_set_header(client, "Content-Type", "application/json");
        esp_http_client_set_post_field(client, body, (int)strlen(body));
    }

    esp_err_t err = esp_http_client_perform(client);
    response->status_code = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (response->overflowed) {
        ESP_LOGE(TAG, "HTTP response was larger than %d bytes", GUARD_HTTP_BUFFER_SIZE);
        return ESP_ERR_NO_MEM;
    }

    return err;
}

static cJSON *guard_parse_json_or_log(const guard_http_response_t *response, const char *context_name) {
    cJSON *root = cJSON_Parse(response->body);
    if (!root) {
        ESP_LOGE(TAG, "%s returned invalid JSON: %s", context_name, response->body);
        return NULL;
    }
    return root;
}

static esp_err_t guard_bootstrap_device(guard_device_context_t *ctx) {
    char url[192] = {0};
    char body[256] = {0};
    guard_http_response_t *response = guard_http_response_new();
    ESP_RETURN_ON_FALSE(response != NULL, ESP_ERR_NO_MEM, TAG, "Could not allocate bootstrap response buffer");

    guard_build_route_url(GUARD_ROUTE_DEVICE_BOOTSTRAP, url, sizeof(url));
    snprintf(
        body,
        sizeof(body),
        "{\"hardware_id\":\"%s\",\"bootstrap_secret\":\"%s\"}",
        ctx->hardware_id,
        ctx->bootstrap_secret
    );

    esp_err_t err = guard_http_request(HTTP_METHOD_POST, url, body, NULL, NULL, response);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Bootstrap request failed: %s", esp_err_to_name(err));
        guard_http_response_free(response);
        return err;
    }

    if (response->status_code == 401) {
        ESP_LOGE(TAG, "Bootstrap secret mismatch for hardware id %s", ctx->hardware_id);
        guard_http_response_free(response);
        return ESP_ERR_INVALID_STATE;
    }

    if (response->status_code < 200 || response->status_code >= 300) {
        ESP_LOGE(TAG, "Bootstrap HTTP %d: %s", response->status_code, response->body);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    cJSON *root = guard_parse_json_or_log(response, "Bootstrap");
    if (!root) {
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"))) {
        char error_text[96] = {0};
        guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(root, "error"), error_text, sizeof(error_text));
        ESP_LOGE(TAG, "Bootstrap rejected by Guardian: %s", error_text);
        cJSON_Delete(root);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "claimed"))) {
        bool has_device_id = guard_json_copy_string(root, "device_id", ctx->device_id, sizeof(ctx->device_id));
        bool has_device_token = guard_json_copy_string(root, "device_token", ctx->device_token, sizeof(ctx->device_token));
        char token_hint[16] = {0};
        guard_json_copy_string(root, "token_hint", token_hint, sizeof(token_hint));

        if (!has_device_id || !has_device_token) {
            ESP_LOGE(TAG, "Bootstrap said claimed=true but credentials were incomplete");
            cJSON_Delete(root);
            guard_http_response_free(response);
            return ESP_FAIL;
        }

        ctx->claim_code[0] = '\0';
        ctx->claim_url[0] = '\0';
        ctx->is_claimed = true;
        ctx->last_heartbeat_ms = 0;
        ctx->last_mailbox_updated_at_ms = 0;

        err = guard_store_claimed_credentials(ctx);
        cJSON_Delete(root);
        guard_http_response_free(response);
        ESP_RETURN_ON_ERROR(err, TAG, "Could not save claimed credentials");

        s_bootstrap_failures = 0;
        ESP_LOGI(TAG, "Device claimed as %s (token hint: %s)", ctx->device_id, token_hint[0] ? token_hint : "n/a");
        return ESP_OK;
    }

    guard_json_copy_string(root, "claim_code", ctx->claim_code, sizeof(ctx->claim_code));
    guard_json_copy_string(root, "claim_url", ctx->claim_url, sizeof(ctx->claim_url));
    if (ctx->claim_url[0] == '\0') {
        guard_copy_string(ctx->claim_url, sizeof(ctx->claim_url), GUARD_WORKER_BASE_URL);
    }

    ctx->is_claimed = false;
    cJSON *claim_expires_at = cJSON_GetObjectItemCaseSensitive(root, "claim_expires_at");
    char claim_expires_text[32] = {0};
    guard_describe_json_value(claim_expires_at, claim_expires_text, sizeof(claim_expires_text));
    cJSON_Delete(root);
    guard_http_response_free(response);

    guard_clear_claimed_credentials(ctx);
    s_bootstrap_failures = 0;

    ESP_LOGI(TAG, "Waiting for user claim. Code: %s", ctx->claim_code[0] ? ctx->claim_code : "(missing)");
    ESP_LOGI(TAG, "Claim URL: %s", ctx->claim_url);
    ESP_LOGI(TAG, "Claim expires at (unix ms): %s", claim_expires_text);
    return ESP_OK;
}

static esp_err_t guard_send_heartbeat(guard_device_context_t *ctx) {
    char url[224] = {0};
    guard_http_response_t *response = guard_http_response_new();
    ESP_RETURN_ON_FALSE(response != NULL, ESP_ERR_NO_MEM, TAG, "Could not allocate heartbeat response buffer");

    guard_build_device_route_url(GUARD_ROUTE_HEARTBEAT, ctx->device_id, url, sizeof(url));

    esp_err_t err = guard_http_request(HTTP_METHOD_GET, url, NULL, ctx->device_id, ctx->device_token, response);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Heartbeat request failed: %s", esp_err_to_name(err));
        guard_http_response_free(response);
        return err;
    }

    if (response->status_code == 401 || response->status_code == 404) {
        ESP_LOGW(TAG, "Heartbeat auth failed for %s. Re-running bootstrap.", ctx->device_id);
        guard_http_response_free(response);
        return ESP_ERR_INVALID_STATE;
    }

    if (response->status_code < 200 || response->status_code >= 300) {
        ESP_LOGE(TAG, "Heartbeat HTTP %d: %s", response->status_code, response->body);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    cJSON *root = guard_parse_json_or_log(response, "Heartbeat");
    if (!root) {
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"))) {
        char error_text[96] = {0};
        guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(root, "error"), error_text, sizeof(error_text));
        ESP_LOGE(TAG, "Heartbeat JSON error: %s", error_text);
        cJSON_Delete(root);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    char status_text[32] = {0};
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(root, "status"), status_text, sizeof(status_text));
    s_bootstrap_failures = 0;
    ESP_LOGI(TAG, "Heartbeat OK for %s (%s)", ctx->device_id, status_text[0] ? status_text : "ok");

    cJSON_Delete(root);
    guard_http_response_free(response);
    return ESP_OK;
}

static esp_err_t guard_fetch_mailbox(guard_device_context_t *ctx) {
    char url[224] = {0};
    guard_http_response_t *response = guard_http_response_new();
    ESP_RETURN_ON_FALSE(response != NULL, ESP_ERR_NO_MEM, TAG, "Could not allocate mailbox response buffer");

    guard_build_device_route_url(GUARD_ROUTE_MAILBOX, ctx->device_id, url, sizeof(url));

    esp_err_t err = guard_http_request(HTTP_METHOD_GET, url, NULL, ctx->device_id, ctx->device_token, response);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Mailbox request failed: %s", esp_err_to_name(err));
        guard_http_response_free(response);
        return err;
    }

    if (response->status_code == 401 || response->status_code == 404) {
        ESP_LOGW(TAG, "Mailbox auth failed for %s. Re-running bootstrap.", ctx->device_id);
        guard_http_response_free(response);
        return ESP_ERR_INVALID_STATE;
    }

    if (response->status_code < 200 || response->status_code >= 300) {
        ESP_LOGE(TAG, "Mailbox HTTP %d: %s", response->status_code, response->body);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    cJSON *root = guard_parse_json_or_log(response, "Mailbox");
    if (!root) {
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    if (!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "ok"))) {
        char error_text[96] = {0};
        guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(root, "error"), error_text, sizeof(error_text));
        ESP_LOGE(TAG, "Mailbox JSON error: %s", error_text);
        cJSON_Delete(root);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    cJSON *mailbox = cJSON_GetObjectItemCaseSensitive(root, "mailbox");
    if (!cJSON_IsObject(mailbox)) {
        ESP_LOGE(TAG, "Mailbox response did not contain a mailbox object");
        cJSON_Delete(root);
        guard_http_response_free(response);
        return ESP_FAIL;
    }

    cJSON *updated_at = cJSON_GetObjectItemCaseSensitive(mailbox, "updatedAt");
    int64_t updated_at_ms = cJSON_IsNumber(updated_at) ? (int64_t)cJSON_GetNumberValue(updated_at) : 0;

    if (updated_at_ms != 0 && updated_at_ms == ctx->last_mailbox_updated_at_ms) {
        cJSON_Delete(root);
        guard_http_response_free(response);
        return ESP_OK;
    }

    ctx->last_mailbox_updated_at_ms = updated_at_ms;

    char low_text[32] = {0};
    char high_text[32] = {0};
    char glucose_text[32] = {0};
    char predicted_text[32] = {0};
    char message_text[96] = {0};
    char reprovision_command_text[64] = {0};
    char factory_reset_command_text[64] = {0};

    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_low"), low_text, sizeof(low_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_high"), high_text, sizeof(high_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "current_glucose"), glucose_text, sizeof(glucose_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "predicted_far"), predicted_text, sizeof(predicted_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "message"), message_text, sizeof(message_text));
    cJSON *low_item = cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_low");
    cJSON *high_item = cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_high");
    cJSON *current_item = cJSON_GetObjectItemCaseSensitive(mailbox, "current_glucose");
    guard_describe_json_value(
        cJSON_GetObjectItemCaseSensitive(mailbox, "control_reenter_ble_setup"),
        reprovision_command_text,
        sizeof(reprovision_command_text)
    );
    guard_describe_json_value(
        cJSON_GetObjectItemCaseSensitive(mailbox, "control_factory_reset"),
        factory_reset_command_text,
        sizeof(factory_reset_command_text)
    );

    ESP_LOGI(
        TAG,
        "Mailbox sync: low=%s high=%s current_glucose=%s predicted_far=%s message=%s",
        low_text,
        high_text,
        glucose_text,
        predicted_text,
        message_text
    );

    if (factory_reset_command_text[0] != '\0' && !guard_mailbox_control_matches_last_command(factory_reset_command_text)) {
        cJSON_Delete(root);
        guard_http_response_free(response);
        guard_request_factory_reset_restart(factory_reset_command_text);
        return ESP_OK;
    }

    if (reprovision_command_text[0] != '\0' && !guard_mailbox_control_matches_last_command(reprovision_command_text)) {
        cJSON_Delete(root);
        guard_http_response_free(response);
        guard_request_ble_reprovision_restart(reprovision_command_text);
        return ESP_OK;
    }

    guard_robot_apply_glucose_alert(
        cJSON_IsNumber(low_item),
        cJSON_IsNumber(low_item) ? (int)cJSON_GetNumberValue(low_item) : 0,
        cJSON_IsNumber(high_item),
        cJSON_IsNumber(high_item) ? (int)cJSON_GetNumberValue(high_item) : 0,
        cJSON_IsNumber(current_item),
        cJSON_IsNumber(current_item) ? (int)cJSON_GetNumberValue(current_item) : 0
    );

    cJSON_Delete(root);
    guard_http_response_free(response);
    return ESP_OK;
}

static esp_err_t guard_runtime_tick(guard_device_context_t *ctx) {
    if (!ctx->is_claimed || ctx->device_id[0] == '\0' || ctx->device_token[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }

    if (!guard_is_wifi_connected()) {
        return ESP_ERR_TIMEOUT;
    }

    int64_t now_ms = esp_timer_get_time() / 1000;
    if (ctx->last_heartbeat_ms == 0 || (now_ms - ctx->last_heartbeat_ms) >= GUARD_HEARTBEAT_INTERVAL_MS) {
        ESP_RETURN_ON_ERROR(guard_send_heartbeat(ctx), TAG, "Heartbeat tick failed");
        ctx->last_heartbeat_ms = now_ms;
    }

    ESP_RETURN_ON_ERROR(guard_fetch_mailbox(ctx), TAG, "Mailbox tick failed");
    (void)guard_maybe_switch_back_to_preferred_wifi();
    return ESP_OK;
}

static bool guard_mailbox_control_matches_last_command(const char *command_id) {
    if (!command_id || command_id[0] == '\0') {
        return true;
    }

    return strcmp(s_last_ble_reprovision_command, command_id) == 0;
}

static void guard_request_ble_reprovision_restart(const char *command_id) {
    if (!command_id || command_id[0] == '\0') {
        return;
    }

    if (guard_store_last_ble_reprovision_command(command_id) != ESP_OK) {
        ESP_LOGE(TAG, "Could not record BLE reprovision command id");
        return;
    }

    if (guard_set_force_ble_reprovision_flag(true) != ESP_OK) {
        ESP_LOGE(TAG, "Could not persist forced BLE reprovision flag");
        return;
    }

    ESP_LOGW(TAG, "Guardian requested Bluetooth setup mode. Restarting into BLE provisioning.");
    vTaskDelay(pdMS_TO_TICKS(350));
    esp_restart();
}

static void guard_request_factory_reset_restart(const char *command_id) {
    if (!command_id || command_id[0] == '\0') {
        return;
    }

    if (guard_store_last_ble_reprovision_command(command_id) != ESP_OK) {
        ESP_LOGE(TAG, "Could not record factory reset command id");
        return;
    }

    ESP_LOGW(TAG, "Guardian requested a full factory reset. Clearing saved pairing and Wi-Fi.");
    guard_clear_pending_provision_credentials();

    if (guard_clear_claimed_credentials(&g_ctx) != ESP_OK) {
        ESP_LOGE(TAG, "Could not clear saved claimed credentials");
        return;
    }

    g_ctx.claim_code[0] = '\0';
    g_ctx.claim_url[0] = '\0';

    if (guard_set_force_ble_reprovision_flag(true) != ESP_OK) {
        ESP_LOGE(TAG, "Could not persist Bluetooth reprovision flag during factory reset");
        return;
    }

    if (guard_reset_saved_wifi_provisioning() != ESP_OK) {
        ESP_LOGE(TAG, "Could not clear saved Wi-Fi credentials during factory reset");
        return;
    }

    ESP_LOGW(TAG, "Factory reset complete. Restarting GUARD into Bluetooth setup.");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
}

static void guard_factory_reset_task(void *arg) {
    char command_id[64] = {0};
    if (arg) {
        guard_copy_string(command_id, sizeof(command_id), (const char *)arg);
        free(arg);
    }

    vTaskDelay(pdMS_TO_TICKS(220));
    guard_request_factory_reset_restart(command_id[0] ? command_id : "ble-factory-reset");
    vTaskDelete(NULL);
}

static void guard_run_state_machine(void) {
    guard_state_t state = GUARD_STATE_BOOT;

    while (true) {
        switch (state) {
            case GUARD_STATE_BOOT:
                ESP_LOGI(TAG, "State: BOOT");
                state = GUARD_STATE_LOAD_STORAGE;
                break;

            case GUARD_STATE_LOAD_STORAGE:
                ESP_LOGI(TAG, "State: LOAD_STORAGE");
                if (guard_load_or_create_identity(&g_ctx) == ESP_OK) {
                    state = GUARD_STATE_WAIT_FOR_WIFI;
                } else {
                    state = GUARD_STATE_ERROR;
                }
                break;

            case GUARD_STATE_WAIT_FOR_WIFI:
                ESP_LOGI(TAG, "State: WAIT_FOR_WIFI");
                guard_robot_apply_glucose_alert(false, 0, false, 0, false, 0);
                if (guard_is_wifi_connected()) {
                    s_saved_wifi_failures = 0;
                    state = GUARD_STATE_BOOTSTRAP_DEVICE;
                    break;
                }
                if (!g_ctx.has_wifi_credentials || s_force_ble_reprovision) {
                    s_saved_wifi_failures = 0;
                    if (guard_start_ble_provisioning() != ESP_OK) {
                        state = GUARD_STATE_ERROR;
                        break;
                    }
                } else {
                    guard_robot_show_setup_message("Joining Wi-Fi", "Saved network");
                    if (guard_resume_wifi_from_saved_credentials() != ESP_OK) {
                        s_saved_wifi_failures++;
                        ESP_LOGW(
                            TAG,
                            "Saved Wi-Fi did not connect in time. Retrying saved network (%d).",
                            s_saved_wifi_failures
                        );
                        vTaskDelay(pdMS_TO_TICKS(GUARD_BOOTSTRAP_RETRY_MS));
                        state = GUARD_STATE_WAIT_FOR_WIFI;
                        break;
                    }
                }
                s_saved_wifi_failures = 0;
                state = GUARD_STATE_BOOTSTRAP_DEVICE;
                break;

            case GUARD_STATE_BOOTSTRAP_DEVICE:
                ESP_LOGI(TAG, "State: BOOTSTRAP_DEVICE");
                guard_robot_show_setup_message("Contacting", "Guardian");
                if (guard_bootstrap_device(&g_ctx) == ESP_OK) {
                    s_bootstrap_failures = 0;
                    state = g_ctx.is_claimed ? GUARD_STATE_RUNTIME : GUARD_STATE_WAIT_FOR_CLAIM;
                } else {
                    s_bootstrap_failures++;
                    if (!guard_is_wifi_connected()) {
                        ESP_LOGW(TAG, "Bootstrap failed before Wi-Fi finished connecting. Waiting for Wi-Fi and retrying.");
                        state = GUARD_STATE_WAIT_FOR_WIFI;
                        break;
                    }

                    ESP_LOGW(TAG, "Bootstrap failed on a connected network. Retrying cloud reachability soon.");
                    vTaskDelay(pdMS_TO_TICKS(GUARD_BOOTSTRAP_RETRY_MS));
                }
                break;

            case GUARD_STATE_WAIT_FOR_CLAIM:
                ESP_LOGI(TAG, "State: WAIT_FOR_CLAIM");
                guard_robot_show_setup_message("Finishing up", "with Guardian");
                if (!guard_is_wifi_connected()) {
                    ESP_LOGW(TAG, "Wi-Fi dropped while waiting for claim. Returning to Wi-Fi setup.");
                    state = GUARD_STATE_WAIT_FOR_WIFI;
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(GUARD_BOOTSTRAP_RETRY_MS));
                if (guard_bootstrap_device(&g_ctx) == ESP_OK && g_ctx.is_claimed) {
                    s_bootstrap_failures = 0;
                    state = GUARD_STATE_RUNTIME;
                } else {
                    s_bootstrap_failures++;
                    ESP_LOGW(TAG, "Claim polling failed on a connected network. Retrying soon.");
                }
                break;

            case GUARD_STATE_RUNTIME: {
                // Delay Arduino-side hardware init until GUARD is already past
                // BLE provisioning. Initializing it at boot was colliding with
                // NimBLE startup on this board.
                guard_robot_hw_init();
                esp_err_t err = guard_runtime_tick(&g_ctx);
                if (err == ESP_ERR_INVALID_STATE) {
                    ESP_LOGW(TAG, "Runtime auth is no longer valid. Returning to bootstrap.");
                    state = GUARD_STATE_BOOTSTRAP_DEVICE;
                } else if (err == ESP_ERR_TIMEOUT) {
                    ESP_LOGW(TAG, "Runtime lost Wi-Fi. Returning to Wi-Fi wait state.");
                    state = GUARD_STATE_WAIT_FOR_WIFI;
                }
                vTaskDelay(pdMS_TO_TICKS(GUARD_MAILBOX_INTERVAL_MS));
                break;
            }

            case GUARD_STATE_ERROR:
            default:
                ESP_LOGE(TAG, "State: ERROR");
                vTaskDelay(pdMS_TO_TICKS(3000));
                break;
        }
    }
}

void app_main(void) {
    ESP_ERROR_CHECK(guard_init_platform());
    guard_log_contract();
    guard_log_ble_provisioning_help();

    ESP_LOGI(TAG, "Guardian ESP-IDF firmware booted.");
    ESP_LOGI(TAG, "Current milestone: BLE provisioning, cloud bootstrap, heartbeat, and mailbox sync are active.");

    guard_run_state_machine();
}

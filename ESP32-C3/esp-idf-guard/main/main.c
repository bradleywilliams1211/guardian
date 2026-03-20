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

static const char *TAG = "guardian";
static const int WIFI_CONNECTED_BIT = BIT0;
static const int PROV_ENDED_BIT = BIT1;
static const char *GUARD_PROV_POP = "guardian-setup";

static EventGroupHandle_t s_guard_event_group;
static bool s_wifi_started = false;

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

    char request_text[48] = {0};
    if (inbuf && inlen > 0) {
        size_t copy_len = (size_t)inlen < sizeof(request_text) - 1 ? (size_t)inlen : sizeof(request_text) - 1;
        memcpy(request_text, inbuf, copy_len);
    }

    char response[256] = {0};
    if (strcmp(request_text, "device-info") == 0 || request_text[0] == '\0') {
        snprintf(
            response,
            sizeof(response),
            "{\"hardware_id\":\"%s\",\"device_id\":\"%s\",\"claimed\":%s}",
            g_ctx.hardware_id,
            g_ctx.device_id,
            g_ctx.is_claimed ? "true" : "false"
        );
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
                ESP_LOGI(TAG, "BLE provisioning started");
                break;
            case WIFI_PROV_CRED_RECV: {
                wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
                ESP_LOGI(TAG, "Received Wi-Fi credentials for SSID: %s", (const char *)wifi_sta_cfg->ssid);
                break;
            }
            case WIFI_PROV_CRED_FAIL: {
                wifi_prov_sta_fail_reason_t *reason = (wifi_prov_sta_fail_reason_t *)event_data;
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
                esp_wifi_connect();
                break;
            case WIFI_EVENT_STA_DISCONNECTED:
                ESP_LOGW(TAG, "Wi-Fi disconnected, retrying...");
                xEventGroupClearBits(s_guard_event_group, WIFI_CONNECTED_BIT);
                esp_wifi_connect();
                break;
            default:
                break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected with IP Address: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_guard_event_group, WIFI_CONNECTED_BIT);
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

static esp_err_t guard_start_wifi_station(void) {
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "esp_wifi_set_mode failed");

    if (!s_wifi_started) {
        ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");
        s_wifi_started = true;
        return ESP_OK;
    }

    return esp_wifi_connect();
}

static bool guard_has_dev_wifi_credentials(void) {
    return GUARD_DEV_WIFI_SSID[0] != '\0';
}

static esp_err_t guard_try_dev_wifi_credentials(void) {
    if (!guard_has_dev_wifi_credentials()) {
        return ESP_ERR_NOT_FOUND;
    }

    wifi_config_t wifi_cfg = {0};
    snprintf((char *)wifi_cfg.sta.ssid, sizeof(wifi_cfg.sta.ssid), "%s", GUARD_DEV_WIFI_SSID);
    snprintf((char *)wifi_cfg.sta.password, sizeof(wifi_cfg.sta.password), "%s", GUARD_DEV_WIFI_PASS);

    ESP_LOGI(TAG, "Trying built-in development Wi-Fi credentials for SSID: %s", GUARD_DEV_WIFI_SSID);
    xEventGroupClearBits(s_guard_event_group, WIFI_CONNECTED_BIT);

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "esp_wifi_set_mode failed for dev Wi-Fi");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "esp_wifi_set_storage failed for dev Wi-Fi");

    if (s_wifi_started) {
        (void)esp_wifi_disconnect();
        esp_err_t stop_err = esp_wifi_stop();
        if (stop_err != ESP_OK && stop_err != ESP_ERR_WIFI_NOT_STARTED) {
            ESP_RETURN_ON_ERROR(stop_err, TAG, "esp_wifi_stop failed for dev Wi-Fi");
        }
        s_wifi_started = false;
    }

    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg), TAG, "esp_wifi_set_config failed for dev Wi-Fi");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed for dev Wi-Fi");
    s_wifi_started = true;

    EventBits_t bits = xEventGroupWaitBits(
        s_guard_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdTRUE,
        pdMS_TO_TICKS(GUARD_WIFI_CONNECT_TIMEOUT_MS)
    );

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Connected using built-in development Wi-Fi credentials");
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    ESP_LOGW(TAG, "Built-in development Wi-Fi credentials did not connect");
    (void)esp_wifi_disconnect();
    return ESP_ERR_TIMEOUT;
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

    if (should_commit) {
        ESP_RETURN_ON_ERROR(nvs_commit(handle), TAG, "Could not commit device identity");
    }

    nvs_close(handle);

    ESP_LOGI(TAG, "Loaded device identity: %s", ctx->hardware_id);
    if (ctx->is_claimed) {
        ESP_LOGI(TAG, "Loaded saved claimed credentials for device %s", ctx->device_id);
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

    esp_err_t dev_wifi_err = guard_try_dev_wifi_credentials();
    if (dev_wifi_err == ESP_OK) {
        wifi_prov_mgr_deinit();
        return ESP_OK;
    }
    if (dev_wifi_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "Built-in development Wi-Fi path failed: %s", esp_err_to_name(dev_wifi_err));
    }

    ESP_ERROR_CHECK(wifi_prov_mgr_is_provisioned(&provisioned));

    if (provisioned) {
        ESP_LOGI(TAG, "Wi-Fi is already provisioned, starting station mode");
        wifi_prov_mgr_deinit();
        g_ctx.has_wifi_credentials = true;
        return guard_start_wifi_station();
    }

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

    ESP_LOGI(TAG, "Use the ESP provisioning app or esp_prov.py to send Wi-Fi credentials.");

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
    if (guard_is_wifi_connected()) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    EventBits_t bits = xEventGroupWaitBits(
        s_guard_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdTRUE,
        pdMS_TO_TICKS(GUARD_WIFI_CONNECT_TIMEOUT_MS)
    );

    if (bits & WIFI_CONNECTED_BIT) {
        g_ctx.has_wifi_credentials = true;
        return ESP_OK;
    }

    return ESP_ERR_TIMEOUT;
}

static void guard_log_ble_provisioning_help(void) {
    char service_name[16] = {0};
    guard_build_service_name(service_name, sizeof(service_name));

    ESP_LOGI(TAG, "Guardian BLE provisioning helper");
    ESP_LOGI(TAG, "Service name: %s", service_name);
    ESP_LOGI(TAG, "PoP: %s", GUARD_PROV_POP);
    ESP_LOGI(
        TAG,
        "CLI example: python %s\\tools\\esp_prov\\esp_prov.py --transport ble --service_name %s --sec_ver 1 --pop %s --ssid <wifi> --passphrase <password>",
        "%%IDF_PATH%%",
        service_name,
        GUARD_PROV_POP
    );
}

static esp_err_t guard_resume_wifi_from_saved_credentials(void) {
    esp_err_t dev_wifi_err = guard_try_dev_wifi_credentials();
    if (dev_wifi_err == ESP_OK) {
        return ESP_OK;
    }
    if (dev_wifi_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "Built-in development Wi-Fi path failed: %s", esp_err_to_name(dev_wifi_err));
    }

    ESP_LOGI(TAG, "Trying saved Wi-Fi credentials");
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

    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_low"), low_text, sizeof(low_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "glucose_high"), high_text, sizeof(high_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "current_glucose"), glucose_text, sizeof(glucose_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "predicted_far"), predicted_text, sizeof(predicted_text));
    guard_describe_json_value(cJSON_GetObjectItemCaseSensitive(mailbox, "message"), message_text, sizeof(message_text));

    ESP_LOGI(
        TAG,
        "Mailbox sync: low=%s high=%s current_glucose=%s predicted_far=%s message=%s",
        low_text,
        high_text,
        glucose_text,
        predicted_text,
        message_text
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

    return guard_fetch_mailbox(ctx);
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
                if (!g_ctx.has_wifi_credentials) {
                    if (guard_start_ble_provisioning() != ESP_OK) {
                        state = GUARD_STATE_ERROR;
                        break;
                    }
                } else if (guard_resume_wifi_from_saved_credentials() != ESP_OK) {
                    ESP_LOGW(TAG, "Saved Wi-Fi did not connect in time, reopening BLE provisioning");
                    g_ctx.has_wifi_credentials = false;
                    if (guard_start_ble_provisioning() != ESP_OK) {
                        state = GUARD_STATE_ERROR;
                        break;
                    }
                }
                state = GUARD_STATE_BOOTSTRAP_DEVICE;
                break;

            case GUARD_STATE_BOOTSTRAP_DEVICE:
                ESP_LOGI(TAG, "State: BOOTSTRAP_DEVICE");
                if (guard_bootstrap_device(&g_ctx) == ESP_OK) {
                    state = g_ctx.is_claimed ? GUARD_STATE_RUNTIME : GUARD_STATE_WAIT_FOR_CLAIM;
                } else {
                    ESP_LOGW(TAG, "Bootstrap failed, retrying soon");
                    vTaskDelay(pdMS_TO_TICKS(GUARD_BOOTSTRAP_RETRY_MS));
                }
                break;

            case GUARD_STATE_WAIT_FOR_CLAIM:
                ESP_LOGI(TAG, "State: WAIT_FOR_CLAIM");
                vTaskDelay(pdMS_TO_TICKS(GUARD_BOOTSTRAP_RETRY_MS));
                if (guard_bootstrap_device(&g_ctx) == ESP_OK && g_ctx.is_claimed) {
                    state = GUARD_STATE_RUNTIME;
                }
                break;

            case GUARD_STATE_RUNTIME: {
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

idf_component_register(
    SRCS "main.c" "guard_robot_arduino.cpp"
    INCLUDE_DIRS "."
    REQUIRES nvs_flash esp_wifi esp_event esp_netif esp_http_client bt wifi_provisioning json mbedtls arduino-esp32
)

#ifndef GUARD_ROBOT_ARDUINO_H
#define GUARD_ROBOT_ARDUINO_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void guard_robot_hw_init(void);
void guard_robot_show_setup_message(const char *line0, const char *line1);
void guard_robot_apply_glucose_alert(
    bool has_low_threshold,
    int low_threshold_mgdl,
    bool has_high_threshold,
    int high_threshold_mgdl,
    bool has_current_glucose,
    int current_glucose_mgdl);

#ifdef __cplusplus
}
#endif

#endif

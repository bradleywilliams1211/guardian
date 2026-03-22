#include "guard_robot_arduino.h"

#include <Arduino.h>
#include <Wire.h>

#include <stdio.h>
#include <string.h>

// -------------------------
// Hardware settings to edit
// -------------------------

// Change this if your alert LED is wired to a different pin.
static constexpr uint8_t kAlertLedPin = 8;

// If the LED behaves backwards, swap these two values.
static constexpr uint8_t kLedOnLevel = HIGH;
static constexpr uint8_t kLedOffLevel = LOW;

// These are the old MicroPython LCD I2C pins and address you were using.
// Change them here if your LCD backpack is wired differently.
static constexpr uint8_t kLcdSdaPin = 10;
static constexpr uint8_t kLcdSclPin = 9;
static constexpr uint8_t kLcdAddress = 0x27;
static constexpr uint8_t kLcdColumns = 16;
static constexpr uint8_t kLcdRows = 2;

// -------------------------
// Internal LCD driver state
// -------------------------

static constexpr uint8_t kLcdRs = 0x01;
static constexpr uint8_t kLcdRw = 0x02;
static constexpr uint8_t kLcdEn = 0x04;
static constexpr uint8_t kLcdBacklight = 0x08;

static constexpr uint8_t kCmdClear = 0x01;
static constexpr uint8_t kCmdHome = 0x02;
static constexpr uint8_t kCmdEntryMode = 0x04;
static constexpr uint8_t kCmdDisplayControl = 0x08;
static constexpr uint8_t kCmdFunctionSet = 0x20;
static constexpr uint8_t kCmdSetDdram = 0x80;

static bool sHasLowThreshold = false;
static int sLowThresholdMgdl = 0;
static bool sHasHighThreshold = false;
static int sHighThresholdMgdl = 0;
static bool sHasCurrentGlucose = false;
static int sCurrentGlucoseMgdl = 0;
static bool sArduinoReady = false;
static bool sLcdReady = false;
static bool sSetupMessageActive = true;
static char sSetupLine0[kLcdColumns + 1] = "GUARD Setup";
static char sSetupLine1[kLcdColumns + 1] = "Starting...";
static char sLastLine0[kLcdColumns + 1] = "";
static char sLastLine1[kLcdColumns + 1] = "";

static void lcdExpanderWrite(uint8_t value) {
  Wire.beginTransmission(kLcdAddress);
  Wire.write(value | kLcdBacklight);
  Wire.endTransmission();
}

static void lcdWriteByte(uint8_t value) {
  lcdExpanderWrite(value | kLcdEn);
  lcdExpanderWrite(value);
  delayMicroseconds(50);
}

static void lcdWriteInitNibble(uint8_t nibble) {
  lcdWriteByte(nibble << 4);
}

static void lcdSend(uint8_t value, uint8_t mode) {
  const uint8_t high = value & 0xF0;
  const uint8_t low = (value << 4) & 0xF0;
  lcdWriteByte(high | mode);
  lcdWriteByte(low | mode);
}

static void lcdCommand(uint8_t value) {
  lcdSend(value, 0);
}

static void lcdWriteChar(char value) {
  lcdSend(static_cast<uint8_t>(value), kLcdRs);
}

static void lcdClear(void) {
  lcdCommand(kCmdClear);
  lcdCommand(kCmdHome);
  delay(2);
}

static void lcdSetCursor(uint8_t col, uint8_t row) {
  static const uint8_t rowOffsets[] = {0x00, 0x40, 0x14, 0x54};
  const uint8_t safeRow = row >= kLcdRows ? (kLcdRows - 1) : row;
  lcdCommand(kCmdSetDdram | (col + rowOffsets[safeRow]));
}

static void lcdWriteLine(uint8_t row, const char *text) {
  char padded[kLcdColumns + 1];
  memset(padded, ' ', sizeof(padded) - 1);
  padded[kLcdColumns] = '\0';

  if (text) {
    snprintf(padded, sizeof(padded), "%-*.*s", kLcdColumns, kLcdColumns, text);
  }

  lcdSetCursor(0, row);
  for (size_t i = 0; i < kLcdColumns; ++i) {
    lcdWriteChar(padded[i]);
  }
}

static void lcdInit(void) {
  Wire.begin(kLcdSdaPin, kLcdSclPin, 100000);
  delay(50);

  lcdWriteInitNibble(0x03);
  delay(5);
  lcdWriteInitNibble(0x03);
  delay(1);
  lcdWriteInitNibble(0x03);
  delay(1);
  lcdWriteInitNibble(0x02);
  delay(1);

  lcdCommand(kCmdFunctionSet | 0x08);
  lcdCommand(kCmdDisplayControl | 0x04);
  lcdCommand(kCmdEntryMode | 0x02);
  lcdClear();
  sLcdReady = true;
}

static void copyLcdLine(char *dest, size_t destLen, const char *text) {
  if (!dest || destLen == 0) {
    return;
  }

  if (!text) {
    dest[0] = '\0';
    return;
  }

  snprintf(dest, destLen, "%-*.*s", kLcdColumns, kLcdColumns, text);
}

static void updateLcdOutput(void) {
  if (!sLcdReady) {
    return;
  }

  char line0[kLcdColumns + 1];
  char line1[kLcdColumns + 1];

  if (sSetupMessageActive) {
    copyLcdLine(line0, sizeof(line0), sSetupLine0);
    copyLcdLine(line1, sizeof(line1), sSetupLine1);
  } else if (!sHasCurrentGlucose) {
    snprintf(line0, sizeof(line0), "Waiting for");
    snprintf(line1, sizeof(line1), "glucose...");
  } else {
    snprintf(line0, sizeof(line0), "mg/dl :%d", sCurrentGlucoseMgdl);

    if (sHasLowThreshold && sCurrentGlucoseMgdl < sLowThresholdMgdl) {
      snprintf(line1, sizeof(line1), "Low Blood Sugar");
    } else if (sHasHighThreshold && sCurrentGlucoseMgdl > sHighThresholdMgdl) {
      snprintf(line1, sizeof(line1), "High Blood Sugar");
    } else {
      snprintf(line1, sizeof(line1), "Blood Sugar Fine");
    }
  }

  if (strcmp(line0, sLastLine0) == 0 && strcmp(line1, sLastLine1) == 0) {
    return;
  }

  // Match the old MicroPython behavior more closely: clear the display, then
  // rewrite both lines together. This is a little slower, but it is more
  // reliable on simple I2C LCD backpacks than incremental partial updates.
  lcdClear();
  lcdWriteLine(0, line0);
  lcdWriteLine(1, line1);
  snprintf(sLastLine0, sizeof(sLastLine0), "%s", line0);
  snprintf(sLastLine1, sizeof(sLastLine1), "%s", line1);
}

// Change this if you want the robot to blink, drive a buzzer, or trigger a
// motor instead of a simple LED.
static void applyAlertOutput() {
  const bool shouldTurnLedOn =
      sHasLowThreshold &&
      sHasCurrentGlucose &&
      sCurrentGlucoseMgdl <= sLowThresholdMgdl;

  digitalWrite(kAlertLedPin, shouldTurnLedOn ? kLedOnLevel : kLedOffLevel);
  updateLcdOutput();
}

extern "C" void guard_robot_hw_init(void) {
  if (!sArduinoReady) {
    initArduino();
    pinMode(kAlertLedPin, OUTPUT);
    digitalWrite(kAlertLedPin, kLedOffLevel);
    lcdInit();
    sArduinoReady = true;
  }

  applyAlertOutput();
}

extern "C" void guard_robot_show_setup_message(const char *line0, const char *line1) {
  if (!sArduinoReady) {
    initArduino();
    pinMode(kAlertLedPin, OUTPUT);
    digitalWrite(kAlertLedPin, kLedOffLevel);
    lcdInit();
    sArduinoReady = true;
  }

  sSetupMessageActive = true;
  copyLcdLine(sSetupLine0, sizeof(sSetupLine0), line0);
  copyLcdLine(sSetupLine1, sizeof(sSetupLine1), line1);
  updateLcdOutput();
}

extern "C" void guard_robot_apply_glucose_alert(
    bool has_low_threshold,
    int low_threshold_mgdl,
    bool has_high_threshold,
    int high_threshold_mgdl,
    bool has_current_glucose,
    int current_glucose_mgdl) {
  sHasLowThreshold = has_low_threshold;
  sLowThresholdMgdl = low_threshold_mgdl;
  sHasHighThreshold = has_high_threshold;
  sHighThresholdMgdl = high_threshold_mgdl;
  sHasCurrentGlucose = has_current_glucose;
  sCurrentGlucoseMgdl = current_glucose_mgdl;
  sSetupMessageActive = false;

  if (!sArduinoReady) {
    return;
  }

  applyAlertOutput();
}

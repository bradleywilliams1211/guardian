param(
    [string]$Port = "COM4"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceMainDir = Join-Path $repoRoot "ESP32-C3\esp-idf-guard\main"
$buildMainDir = "C:\Users\bradl\esp\guard-fw\main"
$idfRoot = "C:\Users\bradl\esp\idf"
$idfToolsPath = "C:\Users\bradl\.espressif"
$pythonPath = "C:\Users\bradl\AppData\Local\Programs\Python\Python313"

Write-Host "Copying Arduino files into the build project..."
Copy-Item (Join-Path $sourceMainDir "guard_robot_arduino.cpp") (Join-Path $buildMainDir "guard_robot_arduino.cpp") -Force
Copy-Item (Join-Path $sourceMainDir "guard_robot_arduino.h") (Join-Path $buildMainDir "guard_robot_arduino.h") -Force

Write-Host "Flashing GUARD on $Port..."
$flashCommand = @"
set IDF_TOOLS_PATH=$idfToolsPath&& set PATH=$pythonPath;%PATH%&& cd /d $idfRoot&& call export.bat&& cd /d C:\Users\bradl\esp\guard-fw&& idf.py -p $Port flash
"@

cmd /c $flashCommand

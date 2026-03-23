param(
    [string]$Port = "COM4"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$flashScript = Join-Path $repoRoot "flash-guard.ps1"
$iconPath = Join-Path $repoRoot "favicon_io\favicon.ico"
$heroImagePath = Join-Path $repoRoot "favicon_io\android-chrome-192x192.png"

# =========================
# EDIT HERE: window look
# =========================
# Change the title, size, or general window behavior here.
$themeBg = [System.Drawing.Color]::FromArgb(244, 248, 245)
$themeCard = [System.Drawing.Color]::FromArgb(255, 255, 255)
$themeBorder = [System.Drawing.Color]::FromArgb(217, 227, 221)
$themeInk = [System.Drawing.Color]::FromArgb(24, 34, 30)
$themeMuted = [System.Drawing.Color]::FromArgb(94, 108, 101)
$themeAccent = [System.Drawing.Color]::FromArgb(46, 125, 92)
$themeAccentSoft = [System.Drawing.Color]::FromArgb(226, 241, 233)
$themeDanger = [System.Drawing.Color]::FromArgb(176, 52, 52)
$themeDangerSoft = [System.Drawing.Color]::FromArgb(251, 235, 235)
$themeLogBg = [System.Drawing.Color]::FromArgb(16, 24, 22)
$themeLogInk = [System.Drawing.Color]::FromArgb(228, 237, 232)
$themeStepIdleBg = [System.Drawing.Color]::FromArgb(243, 246, 244)
$themeStepIdleInk = [System.Drawing.Color]::FromArgb(106, 120, 113)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Flash GUARD"
$form.Size = New-Object System.Drawing.Size(860, 650)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.TopMost = $true
$form.BackColor = $themeBg
if (Test-Path $iconPath) {
    $form.Icon = New-Object System.Drawing.Icon($iconPath)
}

$cardPanel = New-Object System.Windows.Forms.Panel
$cardPanel.Location = New-Object System.Drawing.Point(18, 18)
$cardPanel.Size = New-Object System.Drawing.Size(808, 588)
$cardPanel.BackColor = $themeCard
$cardPanel.BorderStyle = "FixedSingle"
$form.Controls.Add($cardPanel)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.Location = New-Object System.Drawing.Point(0, 0)
$accentBar.Size = New-Object System.Drawing.Size(808, 10)
$accentBar.BackColor = $themeAccent
$cardPanel.Controls.Add($accentBar)

$eyebrowLabel = New-Object System.Windows.Forms.Label
$eyebrowLabel.Text = "GUARD DESKTOP FLASHER"
$eyebrowLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$eyebrowLabel.ForeColor = $themeMuted
$eyebrowLabel.AutoSize = $true
$eyebrowLabel.Location = New-Object System.Drawing.Point(24, 28)
$cardPanel.Controls.Add($eyebrowLabel)

# =========================
# EDIT HERE: main heading
# =========================
# This is the large text at the top of the window.
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Flash GUARD"
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = $themeInk
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(24, 48)
$cardPanel.Controls.Add($titleLabel)

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Text = "Copies your Arduino-side robot code, rebuilds the firmware if needed, and uploads it to GUARD."
$subtitleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
$subtitleLabel.ForeColor = $themeMuted
$subtitleLabel.AutoSize = $true
$subtitleLabel.MaximumSize = New-Object System.Drawing.Size(560, 0)
$subtitleLabel.Location = New-Object System.Drawing.Point(26, 84)
$cardPanel.Controls.Add($subtitleLabel)

$heroPanel = New-Object System.Windows.Forms.Panel
$heroPanel.Location = New-Object System.Drawing.Point(640, 28)
$heroPanel.Size = New-Object System.Drawing.Size(140, 104)
$heroPanel.BackColor = $themeAccentSoft
$heroPanel.BorderStyle = "FixedSingle"
$cardPanel.Controls.Add($heroPanel)

if (Test-Path $heroImagePath) {
    $heroImage = [System.Drawing.Image]::FromFile($heroImagePath)
    $heroPicture = New-Object System.Windows.Forms.PictureBox
    $heroPicture.Image = $heroImage
    $heroPicture.SizeMode = "Zoom"
    $heroPicture.Location = New-Object System.Drawing.Point(12, 12)
    $heroPicture.Size = New-Object System.Drawing.Size(46, 46)
    $heroPanel.Controls.Add($heroPicture)
}

$heroTitle = New-Object System.Windows.Forms.Label
$heroTitle.Text = "GUARD"
$heroTitle.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$heroTitle.ForeColor = $themeInk
$heroTitle.AutoSize = $true
$heroTitle.Location = New-Object System.Drawing.Point(66, 16)
$heroPanel.Controls.Add($heroTitle)

$heroSubtitle = New-Object System.Windows.Forms.Label
$heroSubtitle.Text = "Firmware upload"
$heroSubtitle.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$heroSubtitle.ForeColor = $themeMuted
$heroSubtitle.AutoSize = $true
$heroSubtitle.Location = New-Object System.Drawing.Point(66, 38)
$heroPanel.Controls.Add($heroSubtitle)

$portBadge = New-Object System.Windows.Forms.Label
$portBadge.Text = "Port $Port"
$portBadge.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$portBadge.ForeColor = $themeAccent
$portBadge.BackColor = $themeAccentSoft
$portBadge.AutoSize = $true
$portBadge.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$portBadge.Location = New-Object System.Drawing.Point(14, 68)
$heroPanel.Controls.Add($portBadge)

# =========================
# EDIT HERE: live status text
# =========================
# This is the smaller line under the title.
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Preparing"
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = $themeAccent
$statusLabel.BackColor = $themeAccentSoft
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(24, 146)
$cardPanel.Controls.Add($statusLabel)

$percentLabel = New-Object System.Windows.Forms.Label
$percentLabel.Text = "5%"
$percentLabel.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$percentLabel.ForeColor = $themeInk
$percentLabel.AutoSize = $true
$percentLabel.Location = New-Object System.Drawing.Point(724, 144)
$cardPanel.Controls.Add($percentLabel)

function New-StepBadge {
    param(
        [string]$Text,
        [int]$X
    )

    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
    $label.ForeColor = $themeStepIdleInk
    $label.BackColor = $themeStepIdleBg
    $label.AutoSize = $true
    $label.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
    $label.Location = New-Object System.Drawing.Point($X, 182)
    $cardPanel.Controls.Add($label)
    return $label
}

$stepSyncLabel = New-StepBadge "1 Sync files" 24
$stepBuildLabel = New-StepBadge "2 Build" 132
$stepFlashLabel = New-StepBadge "3 Flash" 220

# =========================
# EDIT HERE: progress bar size
# =========================
# You can make the bar wider/taller here.
$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Location = New-Object System.Drawing.Point(24, 224)
$progressBar.Size = New-Object System.Drawing.Size(758, 18)
$progressBar.Minimum = 0
$progressBar.Maximum = 100
$progressBar.Value = 5
$cardPanel.Controls.Add($progressBar)

# This label shows the current stage in a friendlier sentence.
$stageLabel = New-Object System.Windows.Forms.Label
$stageLabel.Text = "Starting launcher"
$stageLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$stageLabel.ForeColor = $themeMuted
$stageLabel.AutoSize = $true
$stageLabel.Location = New-Object System.Drawing.Point(24, 252)
$cardPanel.Controls.Add($stageLabel)

$helperLabel = New-Object System.Windows.Forms.Label
$helperLabel.Text = "Tip: save your code before flashing. This window can stay open while GUARD restarts."
$helperLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$helperLabel.ForeColor = $themeMuted
$helperLabel.AutoSize = $true
$helperLabel.Location = New-Object System.Drawing.Point(24, 276)
$cardPanel.Controls.Add($helperLabel)

$detailsLabel = New-Object System.Windows.Forms.Label
$detailsLabel.Text = "Live details"
$detailsLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$detailsLabel.ForeColor = $themeInk
$detailsLabel.AutoSize = $true
$detailsLabel.Location = New-Object System.Drawing.Point(24, 312)
$cardPanel.Controls.Add($detailsLabel)

$detailsHintLabel = New-Object System.Windows.Forms.Label
$detailsHintLabel.Text = "Raw tool output appears below while GUARD is being uploaded."
$detailsHintLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$detailsHintLabel.ForeColor = $themeMuted
$detailsHintLabel.AutoSize = $true
$detailsHintLabel.Location = New-Object System.Drawing.Point(24, 334)
$cardPanel.Controls.Add($detailsHintLabel)

# =========================
# EDIT HERE: output log box
# =========================
# This is the scrolling text area that shows the raw flash log.
$outputBox = New-Object System.Windows.Forms.TextBox
$outputBox.Location = New-Object System.Drawing.Point(24, 362)
$outputBox.Size = New-Object System.Drawing.Size(758, 156)
$outputBox.Multiline = $true
$outputBox.ScrollBars = "Vertical"
$outputBox.ReadOnly = $true
$outputBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$outputBox.BackColor = $themeLogBg
$outputBox.ForeColor = $themeLogInk
$outputBox.BorderStyle = "FixedSingle"
$cardPanel.Controls.Add($outputBox)

# =========================
# EDIT HERE: button labels
# =========================
# Change button text or positions here.
$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Enabled = $false
$closeButton.Location = New-Object System.Drawing.Point(662, 532)
$closeButton.Size = New-Object System.Drawing.Size(114, 34)
$closeButton.FlatStyle = "Flat"
$closeButton.BackColor = $themeAccent
$closeButton.ForeColor = [System.Drawing.Color]::White
$closeButton.Add_Click({ $form.Close() })
$cardPanel.Controls.Add($closeButton)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = "Copy Log"
$copyButton.Enabled = $false
$copyButton.Location = New-Object System.Drawing.Point(540, 532)
$copyButton.Size = New-Object System.Drawing.Size(108, 34)
$copyButton.FlatStyle = "Flat"
$copyButton.BackColor = [System.Drawing.Color]::White
$copyButton.ForeColor = $themeInk
$copyButton.Add_Click({
    [System.Windows.Forms.Clipboard]::SetText($outputBox.Text)
})
$cardPanel.Controls.Add($copyButton)

$noteLabel = New-Object System.Windows.Forms.Label
$noteLabel.Text = "Typical flash time: 20 to 40 seconds"
$noteLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$noteLabel.ForeColor = $themeMuted
$noteLabel.AutoSize = $true
$noteLabel.Location = New-Object System.Drawing.Point(24, 541)
$cardPanel.Controls.Add($noteLabel)

# Helper that appends one line into the log box.
function Append-Log {
    param([string]$Line)

    if ([string]::IsNullOrWhiteSpace($Line)) {
        return
    }

    $outputBox.AppendText($Line + [Environment]::NewLine)
}

# Helper that updates the friendly top status and the progress bar.
# If you want different wording while flashing, the easiest place to change it
# is usually Update-StageFromLine below.
function Set-Stage {
    param(
        [string]$StatusText,
        [string]$StageText,
        [int]$Percent
    )

    $statusLabel.Text = $StatusText
    $stageLabel.Text = $StageText
    $percentLabel.Text = "$Percent%"

    $statusLower = $StatusText.ToLowerInvariant()
    if ($statusLower.Contains("failed") -or $statusLower.Contains("error")) {
        $statusLabel.ForeColor = $themeDanger
        $statusLabel.BackColor = $themeDangerSoft
    } else {
        $statusLabel.ForeColor = $themeAccent
        $statusLabel.BackColor = $themeAccentSoft
    }

    $syncActive = $Percent -ge 8
    $buildActive = $Percent -ge 34
    $flashActive = $Percent -ge 72
    $complete = $Percent -ge 100 -and -not ($statusLower.Contains("failed") -or $statusLower.Contains("error"))

    foreach ($step in @(
        @{ Label = $stepSyncLabel; Active = $syncActive },
        @{ Label = $stepBuildLabel; Active = $buildActive },
        @{ Label = $stepFlashLabel; Active = $flashActive }
    )) {
        if ($step.Active) {
            $step.Label.BackColor = $themeAccentSoft
            $step.Label.ForeColor = $themeAccent
        } else {
            $step.Label.BackColor = $themeStepIdleBg
            $step.Label.ForeColor = $themeStepIdleInk
        }
    }

    if ($complete) {
        $stepSyncLabel.BackColor = $themeAccentSoft
        $stepBuildLabel.BackColor = $themeAccentSoft
        $stepFlashLabel.BackColor = $themeAccentSoft
    }

    if ($Percent -lt $progressBar.Minimum) {
        $Percent = $progressBar.Minimum
    }
    if ($Percent -gt $progressBar.Maximum) {
        $Percent = $progressBar.Maximum
    }

    $progressBar.Value = $Percent
    $form.Refresh()
}

# =========================
# EDIT HERE: progress messages
# =========================
# This is the best place to customize what the launcher says while it runs.
# Each block watches for text from the flash process, then updates the UI.
# You can safely rewrite the human-facing messages without changing the flash
# command itself.
function Update-StageFromLine {
    param([string]$Line)

    if ($Line -match "Copying Arduino files into the build project") {
        Set-Stage "Copying files..." "Syncing your Arduino-side files into the build project" 12
        return
    }

    if ($Line -match "Flashing GUARD on") {
        Set-Stage "Starting toolchain..." "Opening the ESP-IDF flash pipeline" 22
        return
    }

    if ($Line -match "Executing action: flash") {
        Set-Stage "Building firmware..." "Preparing the firmware image" 34
        return
    }

    if ($Line -match "Running ninja") {
        Set-Stage "Building firmware..." "Compiling only what changed" 44
        return
    }

    if ($Line -match "Project build complete") {
        Set-Stage "Build ready..." "Starting upload to GUARD" 62
        return
    }

    if ($Line -match "Connecting\.\.\.") {
        Set-Stage "Connecting to GUARD..." "Opening the serial link to the ESP32" 72
        return
    }

    if ($Line -match "Writing at 0x") {
        Set-Stage "Uploading firmware..." "Writing the new image to GUARD" 84
        return
    }

    if ($Line -match "Hash of data verified") {
        Set-Stage "Finishing flash..." "Verifying the uploaded image" 94
        return
    }

    if ($Line -match "^Done$") {
        Set-Stage "Done" "GUARD finished flashing successfully" 100
        return
    }
}

# =========================
# Internal process launch
# =========================
# Most people do not need to edit below this point.
# This section starts flash-guard.ps1, streams output into the window, and
# closes everything out when flashing finishes.
$process = New-Object System.Diagnostics.Process
$process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$process.StartInfo.FileName = "powershell.exe"
$process.StartInfo.Arguments = "-ExecutionPolicy Bypass -File `"$flashScript`" -Port `"$Port`""
$process.StartInfo.WorkingDirectory = $repoRoot
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.CreateNoWindow = $true
$process.EnableRaisingEvents = $true

$outputHandler = [System.Diagnostics.DataReceivedEventHandler]{
    param($sender, $eventArgs)
    if ($null -eq $eventArgs.Data) {
        return
    }

    $line = $eventArgs.Data
    $form.BeginInvoke([Action]{
        Append-Log $line
        Update-StageFromLine $line
    }) | Out-Null
}

$errorHandler = [System.Diagnostics.DataReceivedEventHandler]{
    param($sender, $eventArgs)
    if ($null -eq $eventArgs.Data) {
        return
    }

    $line = $eventArgs.Data
    $form.BeginInvoke([Action]{
        Append-Log $line
        Update-StageFromLine $line
    }) | Out-Null
}

$process.add_OutputDataReceived($outputHandler)
$process.add_ErrorDataReceived($errorHandler)

$process.add_Exited({
    $form.BeginInvoke([Action]{
        if ($process.ExitCode -eq 0) {
            Set-Stage "Flash complete" "GUARD is ready" 100
            Append-Log ""
            Append-Log "Flash completed successfully."
            $titleLabel.Text = "GUARD is ready"
            $subtitleLabel.Text = "Your latest Arduino-side robot code has been copied and uploaded successfully."
            $heroSubtitle.Text = "Ready to unplug"
        } else {
            Set-Stage "Flash failed" "Something interrupted the upload" 100
            Append-Log ""
            Append-Log "Flash failed. Review the log above."
            $titleLabel.Text = "Flash failed"
            $subtitleLabel.Text = "The upload did not finish. Review the log, then try again after checking the cable and port."
            $heroSubtitle.Text = "Needs attention"
        }

        $closeButton.Enabled = $true
        $copyButton.Enabled = $true
    }) | Out-Null
}) | Out-Null

try {
    Set-Stage "Launching..." "Starting the flash helper" 8
    $null = $process.Start()
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
} catch {
    Append-Log $_.Exception.Message
    Set-Stage "Launch failed" "Could not start the flash helper" 100
    $titleLabel.Text = "Could not start flashing"
    $subtitleLabel.Text = "The launcher could not start the flash helper. Review the message below and try again."
    $heroSubtitle.Text = "Launcher error"
    $closeButton.Enabled = $true
    $copyButton.Enabled = $true
}

[void]$form.ShowDialog()

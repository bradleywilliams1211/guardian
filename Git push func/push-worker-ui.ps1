Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$pushScript = Join-Path $scriptRoot "push-worker.ps1"
$iconPath = Join-Path $repoRoot "favicon_io\favicon.ico"
$heroImagePath = Join-Path $repoRoot "favicon_io\android-chrome-192x192.png"

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

$script:pushProcess = $null
$script:lastRunHadChanges = $true
$script:lastDeployVersion = ""
$script:lastLogPath = Join-Path (Join-Path $env:LOCALAPPDATA "Guardian") "last-deploy.log"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Push and Deploy Guardian"
$form.Size = New-Object System.Drawing.Size(920, 720)
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
$cardPanel.Size = New-Object System.Drawing.Size(868, 648)
$cardPanel.BackColor = $themeCard
$cardPanel.BorderStyle = "FixedSingle"
$form.Controls.Add($cardPanel)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.Location = New-Object System.Drawing.Point(0, 0)
$accentBar.Size = New-Object System.Drawing.Size(868, 10)
$accentBar.BackColor = $themeAccent
$cardPanel.Controls.Add($accentBar)

$eyebrowLabel = New-Object System.Windows.Forms.Label
$eyebrowLabel.Text = "GUARDIAN GIT PUSHER"
$eyebrowLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$eyebrowLabel.ForeColor = $themeMuted
$eyebrowLabel.AutoSize = $true
$eyebrowLabel.Location = New-Object System.Drawing.Point(24, 28)
$cardPanel.Controls.Add($eyebrowLabel)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = "Push and Deploy Guardian"
$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$titleLabel.ForeColor = $themeInk
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(24, 48)
$cardPanel.Controls.Add($titleLabel)

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Text = "Stages everything in Guardian, creates one commit, pushes it to GitHub, then deploys the live Worker and site to Cloudflare."
$subtitleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
$subtitleLabel.ForeColor = $themeMuted
$subtitleLabel.AutoSize = $true
$subtitleLabel.MaximumSize = New-Object System.Drawing.Size(560, 0)
$subtitleLabel.Location = New-Object System.Drawing.Point(26, 84)
$cardPanel.Controls.Add($subtitleLabel)

$heroPanel = New-Object System.Windows.Forms.Panel
$heroPanel.Location = New-Object System.Drawing.Point(666, 28)
$heroPanel.Size = New-Object System.Drawing.Size(164, 114)
$heroPanel.BackColor = $themeAccentSoft
$heroPanel.BorderStyle = "FixedSingle"
$cardPanel.Controls.Add($heroPanel)

if (Test-Path $heroImagePath) {
    $heroImage = [System.Drawing.Image]::FromFile($heroImagePath)
    $heroPicture = New-Object System.Windows.Forms.PictureBox
    $heroPicture.Image = $heroImage
    $heroPicture.SizeMode = "Zoom"
    $heroPicture.Location = New-Object System.Drawing.Point(12, 12)
    $heroPicture.Size = New-Object System.Drawing.Size(48, 48)
    $heroPanel.Controls.Add($heroPicture)
}

$heroTitle = New-Object System.Windows.Forms.Label
$heroTitle.Text = "GitHub + Cloudflare"
$heroTitle.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$heroTitle.ForeColor = $themeInk
$heroTitle.AutoSize = $true
$heroTitle.Location = New-Object System.Drawing.Point(70, 16)
$heroPanel.Controls.Add($heroTitle)

$heroSubtitle = New-Object System.Windows.Forms.Label
$heroSubtitle.Text = "Push then deploy"
$heroSubtitle.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$heroSubtitle.ForeColor = $themeMuted
$heroSubtitle.AutoSize = $true
$heroSubtitle.Location = New-Object System.Drawing.Point(70, 38)
$heroPanel.Controls.Add($heroSubtitle)

$repoBadge = New-Object System.Windows.Forms.Label
$repoBadge.Text = "master -> origin + live"
$repoBadge.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$repoBadge.ForeColor = $themeAccent
$repoBadge.BackColor = $themeAccentSoft
$repoBadge.AutoSize = $true
$repoBadge.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$repoBadge.Location = New-Object System.Drawing.Point(14, 72)
$heroPanel.Controls.Add($repoBadge)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = "Ready"
$statusLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$statusLabel.ForeColor = $themeAccent
$statusLabel.BackColor = $themeAccentSoft
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$statusLabel.AutoSize = $true
$statusLabel.Location = New-Object System.Drawing.Point(24, 156)
$cardPanel.Controls.Add($statusLabel)

$versionLabel = New-Object System.Windows.Forms.Label
$versionLabel.Text = "Version: waiting for deploy"
$versionLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$versionLabel.ForeColor = $themeMuted
$versionLabel.AutoSize = $true
$versionLabel.Location = New-Object System.Drawing.Point(184, 162)
$cardPanel.Controls.Add($versionLabel)

$percentLabel = New-Object System.Windows.Forms.Label
$percentLabel.Text = "0%"
$percentLabel.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$percentLabel.ForeColor = $themeInk
$percentLabel.AutoSize = $true
$percentLabel.Location = New-Object System.Drawing.Point(778, 154)
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
    $label.Location = New-Object System.Drawing.Point($X, 192)
    $cardPanel.Controls.Add($label)
    return $label
}

$stepAddLabel = New-StepBadge "1 Stage files" 24
$stepCommitLabel = New-StepBadge "2 Commit" 142
$stepPushLabel = New-StepBadge "3 Push" 236
$stepDeployLabel = New-StepBadge "4 Deploy" 318

$progressBar = New-Object System.Windows.Forms.ProgressBar
$progressBar.Location = New-Object System.Drawing.Point(24, 232)
$progressBar.Size = New-Object System.Drawing.Size(806, 18)
$progressBar.Minimum = 0
$progressBar.Maximum = 100
$progressBar.Value = 0
$cardPanel.Controls.Add($progressBar)

$stageLabel = New-Object System.Windows.Forms.Label
$stageLabel.Text = "Add a commit message, then start the push and deploy flow."
$stageLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$stageLabel.ForeColor = $themeMuted
$stageLabel.AutoSize = $true
$stageLabel.Location = New-Object System.Drawing.Point(24, 260)
$cardPanel.Controls.Add($stageLabel)

$messageLabel = New-Object System.Windows.Forms.Label
$messageLabel.Text = "Commit message"
$messageLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$messageLabel.ForeColor = $themeInk
$messageLabel.AutoSize = $true
$messageLabel.Location = New-Object System.Drawing.Point(24, 300)
$cardPanel.Controls.Add($messageLabel)

$messageHintLabel = New-Object System.Windows.Forms.Label
$messageHintLabel.Text = "Example: Refine hero explode tuning"
$messageHintLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$messageHintLabel.ForeColor = $themeMuted
$messageHintLabel.AutoSize = $true
$messageHintLabel.Location = New-Object System.Drawing.Point(24, 322)
$cardPanel.Controls.Add($messageHintLabel)

$messageBox = New-Object System.Windows.Forms.TextBox
$messageBox.Location = New-Object System.Drawing.Point(24, 348)
$messageBox.Size = New-Object System.Drawing.Size(806, 30)
$messageBox.Font = New-Object System.Drawing.Font("Segoe UI", 11)
$cardPanel.Controls.Add($messageBox)

$helperLabel = New-Object System.Windows.Forms.Label
$helperLabel.Text = "This stages everything in the Guardian repo, commits it, pushes it, and then runs Wrangler deploy."
$helperLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$helperLabel.ForeColor = $themeMuted
$helperLabel.AutoSize = $true
$helperLabel.Location = New-Object System.Drawing.Point(24, 382)
$cardPanel.Controls.Add($helperLabel)

$detailsLabel = New-Object System.Windows.Forms.Label
$detailsLabel.Text = "Live details"
$detailsLabel.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$detailsLabel.ForeColor = $themeInk
$detailsLabel.AutoSize = $true
$detailsLabel.Location = New-Object System.Drawing.Point(24, 420)
$cardPanel.Controls.Add($detailsLabel)

$detailsHintLabel = New-Object System.Windows.Forms.Label
$detailsHintLabel.Text = "Git and Wrangler output appear below while the flow runs."
$detailsHintLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$detailsHintLabel.ForeColor = $themeMuted
$detailsHintLabel.AutoSize = $true
$detailsHintLabel.Location = New-Object System.Drawing.Point(24, 442)
$cardPanel.Controls.Add($detailsHintLabel)

$outputBox = New-Object System.Windows.Forms.TextBox
$outputBox.Location = New-Object System.Drawing.Point(24, 468)
$outputBox.Size = New-Object System.Drawing.Size(806, 122)
$outputBox.Multiline = $true
$outputBox.ScrollBars = "Vertical"
$outputBox.ReadOnly = $true
$outputBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$outputBox.BackColor = $themeLogBg
$outputBox.ForeColor = $themeLogInk
$outputBox.BorderStyle = "FixedSingle"
$cardPanel.Controls.Add($outputBox)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "Close"
$closeButton.Location = New-Object System.Drawing.Point(710, 604)
$closeButton.Size = New-Object System.Drawing.Size(120, 34)
$closeButton.FlatStyle = "Flat"
$closeButton.BackColor = $themeAccent
$closeButton.ForeColor = [System.Drawing.Color]::White
$closeButton.Add_Click({ $form.Close() })
$cardPanel.Controls.Add($closeButton)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = "Copy Log"
$copyButton.Enabled = $false
$copyButton.Location = New-Object System.Drawing.Point(586, 604)
$copyButton.Size = New-Object System.Drawing.Size(108, 34)
$copyButton.FlatStyle = "Flat"
$copyButton.BackColor = [System.Drawing.Color]::White
$copyButton.ForeColor = $themeInk
$copyButton.Add_Click({
    [System.Windows.Forms.Clipboard]::SetText($outputBox.Text)
})
$cardPanel.Controls.Add($copyButton)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = "Commit and Deploy"
$startButton.Location = New-Object System.Drawing.Point(24, 604)
$startButton.Size = New-Object System.Drawing.Size(152, 34)
$startButton.FlatStyle = "Flat"
$startButton.BackColor = $themeAccent
$startButton.ForeColor = [System.Drawing.Color]::White
$cardPanel.Controls.Add($startButton)

function Invoke-Ui {
    param([scriptblock]$Action)

    if ($form.IsDisposed) {
        return
    }

    if ($form.InvokeRequired) {
        $form.BeginInvoke($Action) | Out-Null
    } else {
        & $Action
    }
}

function Set-StepState {
    param(
        [System.Windows.Forms.Label]$Label,
        [bool]$IsActive
    )

    if ($IsActive) {
        $Label.BackColor = $themeAccentSoft
        $Label.ForeColor = $themeAccent
    } else {
        $Label.BackColor = $themeStepIdleBg
        $Label.ForeColor = $themeStepIdleInk
    }
}

function Set-Stage {
    param(
        [string]$Status,
        [string]$Detail,
        [int]$Percent,
        [string]$ActiveStep,
        [bool]$IsError = $false
    )

    $progressBar.Value = [Math]::Min([Math]::Max($Percent, 0), 100)
    $percentLabel.Text = "$Percent%"
    $statusLabel.Text = $Status
    $stageLabel.Text = $Detail

    if ($IsError) {
        $statusLabel.BackColor = $themeDangerSoft
        $statusLabel.ForeColor = $themeDanger
    } else {
        $statusLabel.BackColor = $themeAccentSoft
        $statusLabel.ForeColor = $themeAccent
    }

    Set-StepState $stepAddLabel ($ActiveStep -eq "add")
    Set-StepState $stepCommitLabel ($ActiveStep -eq "commit")
    Set-StepState $stepPushLabel ($ActiveStep -eq "push")
    Set-StepState $stepDeployLabel ($ActiveStep -eq "deploy")
}

function Append-Output {
    param([string]$Line)

    if ([string]::IsNullOrWhiteSpace($Line)) {
        return
    }

    $outputBox.AppendText($Line + [Environment]::NewLine)
    $outputBox.SelectionStart = $outputBox.TextLength
    $outputBox.ScrollToCaret()
}

function Update-StageFromLine {
    param([string]$Line)

    switch -Regex ($Line) {
        '^\[stage\]\s+add$' {
            Set-Stage "Staging" "Adding changed files to the commit." 22 "add"
            break
        }
        '^\[stage\]\s+commit$' {
            Set-Stage "Committing" "Saving your message into a new commit." 58 "commit"
            break
        }
        '^\[stage\]\s+push$' {
            Set-Stage "Pushing" "Sending the new commit to GitHub." 84 "push"
            break
        }
        '^\[stage\]\s+deploy$' {
            Set-Stage "Deploying" "Publishing the Worker and site to Cloudflare." 94 "deploy"
            break
        }
        '^No staged changes found\. Nothing to commit\.$' {
            $script:lastRunHadChanges = $false
            Set-Stage "Up to date" "There were no new changes to commit. Deploy will still run." 74 "" 
            break
        }
        '^No staged changes found\. Skipping commit and push\.$' {
            $script:lastRunHadChanges = $false
            Set-Stage "Up to date" "There were no new changes to commit. Deploy will still run." 74 "" 
            break
        }
        '^Current Version ID:\s+(.+)$' {
            $script:lastDeployVersion = $Matches[1].Trim()
            $versionLabel.Text = "Version: " + $script:lastDeployVersion
            break
        }
        '^\[stage\]\s+done$' {
            if ($script:lastRunHadChanges) {
                Set-Stage "Done" "Commit, push, and live deploy finished." 100 ""
            } else {
                Set-Stage "Done" "There was nothing new to push, but the live deploy finished." 100 ""
            }
            break
        }
    }
}

$startButton.Add_Click({
    $message = $messageBox.Text.Trim()

    if ([string]::IsNullOrWhiteSpace($message)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Add a commit message first.",
            "Commit message required",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        return
    }

    if ($script:pushProcess -and -not $script:pushProcess.HasExited) {
        return
    }

    $script:lastRunHadChanges = $true
    $script:lastDeployVersion = ""
    $outputBox.Clear()
    $copyButton.Enabled = $false
    $startButton.Enabled = $false
    $messageBox.Enabled = $false
    $heroSubtitle.Text = "Running push and deploy flow"
    $versionLabel.Text = "Version: waiting for deploy"
    Set-Stage "Starting" "Opening the Git and Wrangler process." 8 ""

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = "powershell.exe"
    $process.StartInfo.Arguments = "-ExecutionPolicy Bypass -File `"$pushScript`""
    $process.StartInfo.WorkingDirectory = $repoRoot
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.EnvironmentVariables["GUARD_COMMIT_MESSAGE"] = $message
    $process.EnableRaisingEvents = $true

    $process.add_OutputDataReceived({
        param($sender, $eventArgs)
        if ($null -eq $eventArgs.Data) {
            return
        }

        $line = $eventArgs.Data
        Invoke-Ui {
            Append-Output $line
            Update-StageFromLine $line
        }
    })

    $process.add_ErrorDataReceived({
        param($sender, $eventArgs)
        if ($null -eq $eventArgs.Data) {
            return
        }

        $line = $eventArgs.Data
        Invoke-Ui {
            Append-Output $line
        }
    })

    $process.add_Exited({
        $exitCode = $process.ExitCode
        Invoke-Ui {
            $copyButton.Enabled = $true
            $startButton.Enabled = $true
            $messageBox.Enabled = $true
            $closeButton.Enabled = $true

            if ($exitCode -eq 0) {
            if ($script:lastRunHadChanges) {
                Set-Stage "Done" "Your Guardian repo is pushed and the live Cloudflare deploy is finished." 100 ""
                $heroSubtitle.Text = "Push and deploy complete"
            } else {
                Set-Stage "Done" "There was nothing new to push, but the live Cloudflare deploy is finished." 100 ""
                $heroSubtitle.Text = "Already current"
            }
            } else {
                Set-Stage "Needs attention" ("The flow stopped early. Check " + $script:lastLogPath) 100 "" $true
                $heroSubtitle.Text = "Push or deploy did not finish"
            }
        }
    })

    $script:pushProcess = $process
    $null = $process.Start()
    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()
})

$form.Add_Shown({
    $messageBox.Focus()
})

[void]$form.ShowDialog()

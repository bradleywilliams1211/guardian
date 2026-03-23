param(
    [string]$CommitMessage
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$logPath = Join-Path $scriptRoot "last-deploy.log"
Set-Location $repoRoot

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    $CommitMessage = $env:GUARD_COMMIT_MESSAGE
}

$CommitMessage = [string]$CommitMessage

if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
    throw "Commit message is required."
}

try {
    if (Test-Path $logPath) {
        Remove-Item $logPath -Force
    }
} catch {}

function Write-LogLine {
    param([string]$Line)

    Write-Output $Line
    Add-Content -Path $logPath -Value $Line
}

function Format-CmdArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($Value -match '[\s"&|<>^()]') {
        return '"' + $Value.Replace('"', '\"') + '"'
    }

    return $Value
}

function Invoke-GitStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Stage,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-LogLine "[stage] $Stage"
    $gitCommand = 'git ' + (($Arguments | ForEach-Object { Format-CmdArgument $_ }) -join ' ')
    Write-LogLine ('$ ' + $gitCommand)

    & cmd /c ($gitCommand + ' 2>&1') | ForEach-Object {
        Write-LogLine ($_.ToString())
    }

    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

Write-LogLine "Guardian repo: $repoRoot"
Write-LogLine "Log file: $logPath"
Write-LogLine "[info] Working tree"

& git status --short --branch 2>&1 | ForEach-Object {
    Write-LogLine ($_.ToString())
}

if ($LASTEXITCODE -ne 0) {
    throw "git status failed with exit code $LASTEXITCODE."
}

Invoke-GitStep -Stage "add" -Arguments @("add", ".")

Write-LogLine "[info] Checking staged changes"
& git diff --cached --quiet

switch ($LASTEXITCODE) {
    0 {
        Write-LogLine "No staged changes found. Skipping commit and push."
    }
    1 {
        Invoke-GitStep -Stage "commit" -Arguments @("commit", "-m", $CommitMessage)
        Invoke-GitStep -Stage "push" -Arguments @("push")
    }
    default {
        throw "git diff --cached --quiet failed with exit code $LASTEXITCODE."
    }
}

Write-LogLine "[stage] deploy"
Write-LogLine '$ npx wrangler whoami'
& cmd /c "npx wrangler whoami 2>&1" | ForEach-Object {
    Write-LogLine ($_.ToString())
}

if ($LASTEXITCODE -ne 0) {
    throw "wrangler whoami failed with exit code $LASTEXITCODE."
}

Write-LogLine '$ cmd /c "set CI=&& npx wrangler deploy"'
& cmd /c "set CI=&& npx wrangler deploy" 2>&1 | ForEach-Object {
    Write-LogLine ($_.ToString())
}

if ($LASTEXITCODE -ne 0) {
    throw "wrangler deploy failed with exit code $LASTEXITCODE."
}

Write-LogLine "[stage] done"
Write-LogLine "Push and deploy complete."

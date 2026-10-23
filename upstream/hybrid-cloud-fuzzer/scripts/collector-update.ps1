# Trusted-main automatic updater for the managed Windows collector.
# Runs as Role=Updater; it never reads DPAPI tokens or forces DEMO branch clicks.
param(
    [ValidateRange(30,3600)][int]$IntervalSeconds = 120,
    [switch]$Once,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$script:repo = Split-Path $PSScriptRoot -Parent
$script:statusDir = Join-Path $script:repo '.local-state'
$script:statusFile = Join-Path $script:statusDir 'auto-update-status.json'
$script:drainFile = Join-Path $script:statusDir 'update-drain.flag'
$script:settingsFile = Join-Path $script:statusDir 'collector-control.json'
$script:controlScript = Join-Path $PSScriptRoot 'collector-control.ps1'
$script:utf8 = New-Object System.Text.UTF8Encoding($false)
$script:git = (Get-Command git.exe -ErrorAction Stop).Source
$script:npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$script:ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$null = New-Item -ItemType Directory -Path $script:statusDir -Force

function Write-UpdateStatus([string]$State,[string]$Message,[string]$Target = '') {
    $report = @{
        state = $State
        message = $Message.Substring(0,[Math]::Min($Message.Length,400))
        targetSha = $Target
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Depth 4
    $temporary = $script:statusFile + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary,$report,$script:utf8)
    Move-Item -LiteralPath $temporary -Destination $script:statusFile -Force
    Write-Output "AUTOUPDATE $State $Message"
}
function Invoke-Native([string]$Executable,[string[]]$Arguments) {
    # Capture stderr without treating an npm warning as a PowerShell exception.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Executable @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($exitCode -ne 0) {
        $tail = (($output | Select-Object -Last 7) -join ' ')
        throw "Command failed (exit $exitCode): $tail"
    }
    return (($output -join [Environment]::NewLine).Trim())
}
function Git([string[]]$Arguments) {
    return Invoke-Native $script:git (@('-C',$script:repo) + $Arguments)
}
function Test-SafeRepo {
    $origin = Git @('remote','get-url','origin')
    if ($origin -cnotmatch '^(?i:https://github\.com/|git@github\.com:|ssh://git@github\.com/)Shisetsu-Code/hybrid-cloud-fuzzer(?:\.git)?$') {
        throw 'origin is not the approved Shisetsu-Code/hybrid-cloud-fuzzer repository'
    }
    $branch = Git @('branch','--show-current')
    if ($branch -cne 'main') { throw 'updates require the local main branch' }
    if ((Git @('status','--porcelain','--untracked-files=normal')).Length -gt 0) {
        throw 'local source edits or untracked files found; refusing to overwrite them'
    }
}
function Test-RemoteHealth([string]$Target) {
    $config = Get-Content -Raw -LiteralPath $script:settingsFile | ConvertFrom-Json
    if (-not $config.workerUrl) { throw 'Worker URL is missing from local configuration' }
    $url = $config.workerUrl.TrimEnd('/') + '/health'
    $health = Invoke-RestMethod -Uri $url -TimeoutSec 12 -Method Get
    # Require the schema of the TARGET commit, not the older local checkout.
    $paths = Git @('ls-tree','-r','--name-only',$Target,'migrations')
    $versions = @($paths -split [Environment]::NewLine |
        ForEach-Object { if ($_ -match '^migrations/(\d{4})_.*\.sql$') { [int]$Matches[1] } })
    $minimum = if ($versions.Count -gt 0) { ($versions | Measure-Object -Maximum).Maximum } else { 1 }
    if ($health.ok -ne $true -or [int]$health.schemaVersion -lt [int]$minimum) {
        throw "Cloudflare Worker/D1 not ready (schema $($health.schemaVersion); needs >=$minimum)"
    }
}
function Preflight([string]$Target) {
    $staging = Join-Path $script:statusDir ("autoupdate-preflight-" + $Target.Substring(0,12))
    if (Test-Path -LiteralPath $staging) { throw 'stale preflight worktree; refusing to remove unknown directory' }
    $added = $false
    try {
        $null = Git @('worktree','add','--detach',$staging,$Target)
        $added = $true
        Push-Location -LiteralPath $staging
        try {
            $null = Invoke-Native $script:npm @('ci','--ignore-scripts','--no-audit','--no-fund')
            $null = Invoke-Native $script:npm @('run','check')
            $null = Invoke-Native $script:npm @('test')
        } finally { Pop-Location }
    } finally {
        if ($added) { $null = Git @('worktree','remove','--force',$staging) }
    }
}
function Controller([string[]]$Arguments) {
    return Invoke-Native $script:ps (@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$script:controlScript) + $Arguments)
}
function Poll-Once {
    try {
        Test-SafeRepo
        $current = Git @('rev-parse','HEAD')
        $null = Git @('fetch','--quiet','origin','+refs/heads/main:refs/remotes/origin/main')
        $target = Git @('rev-parse','refs/remotes/origin/main')
        if ($current -eq $target) {
            Write-UpdateStatus 'current' 'already at GitHub main' $current
            return
        }
        $null = & $script:git -C $script:repo merge-base --is-ancestor $current $target
        if ($LASTEXITCODE -ne 0) { throw 'GitHub main diverged; no automatic reset or force pull' }
        if ($CheckOnly) {
            Write-UpdateStatus 'available' 'new fast-forward main revision detected (check-only)' $target
            return
        }
        Test-RemoteHealth $target
        Write-UpdateStatus 'testing' 'running staged validation without stopping workers' $target
        Preflight $target
        Test-SafeRepo
        if ((Git @('rev-parse','HEAD')) -ne $current) { throw 'local checkout changed during preflight; retry later' }
        [IO.File]::WriteAllText($script:drainFile,$target,$script:utf8)
        try {
            Write-UpdateStatus 'draining' 'waiting for workers to finish their current task' $target
            $null = Controller @('-Action','Stop','-KeepUpdater','-Graceful')
            Test-SafeRepo
            $null = Git @('merge','--ff-only',$target)
            $null = Invoke-Native $script:npm @('ci','--ignore-scripts','--no-audit','--no-fund')
            Write-UpdateStatus 'updated' 'main updated and dependencies installed; restarting collector' $target
        } finally {
            Remove-Item -LiteralPath $script:drainFile -Force -ErrorAction SilentlyContinue
            # Restart even if one worker had already drained before a timeout.
            try { $null = Controller @('-Action','Start') }
            catch { Write-Output "AUTOUPDATE RESTART ERROR $($_.Exception.Message)" }
        }
    } catch {
        Write-UpdateStatus 'deferred' $_.Exception.Message
    }
}

# A named mutex prevents manual -Once and the managed updater from racing.
$hash = [Security.Cryptography.SHA256]::Create()
try { $name = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:repo.ToLowerInvariant())))).Replace('-','') }
finally { $hash.Dispose() }
$mutex = New-Object Threading.Mutex($false,('Local\HybridAutoUpdater'+$name))
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { Write-Output 'AUTOUPDATE already running'; exit 0 }
    do {
        Poll-Once
        if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
    } while (-not $Once)
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

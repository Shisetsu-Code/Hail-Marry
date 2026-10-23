param([Parameter(Mandatory=$true)][ValidateSet('Capture','Sync','Branches','Workforce','Updater')][string]$Role)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
$config = Get-Content -Raw -LiteralPath (Join-Path $repo '.local-state/collector-control.json') | ConvertFrom-Json
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ($Role -eq 'Updater') {
    # No secret access: the updater fetches only the trusted GitHub main branch.
    & (Join-Path $repo 'scripts/collector-update.ps1')
} elseif ($Role -eq 'Workforce') {
    $secrets = Import-Clixml -LiteralPath (Join-Path $repo '.wrangler/deployment-secrets.xml')
    $env:HYBRID_FUZZER_URL = $config.workerUrl
    $env:HYBRID_INGEST_TOKEN = [Net.NetworkCredential]::new('', $secrets['INGEST_TOKEN']).Password
    $env:HYBRID_REVIEW_TOKEN = [Net.NetworkCredential]::new('', $secrets['REVIEW_TOKEN']).Password
    if (-not $env:HYBRID_INGEST_TOKEN -or -not $env:HYBRID_REVIEW_TOKEN) { throw 'Faltan credenciales privadas para Workforce.' }
    $env:PLAYWRIGHT_BROWSERS_PATH = $config.browserPath
    Remove-Variable secrets
    $maxWorkers = if ($config.maxWorkers) { [int]$config.maxWorkers } else { 5 }
    $browserWorkers = if ($config.browserWorkers) { [int]$config.browserWorkers } else { 3 }
    $arguments = @((Join-Path $repo 'local/workforce.mjs'), "--manifest=$($config.manifest)", "--out=$($config.outbox)",
        "--max-workers=$maxWorkers", "--browser-workers=$browserWorkers", '--interval-ms=15000', "--speed=$($config.speed)", "--wait-ms=$($config.waitMs)")
    if ($config.providerSourcesPath) { $arguments += "--providers=$($config.providerSourcesPath)" }
    if ($config.adultConfirmed -eq $true) { $arguments += '--confirm-adult' }
    & $node @arguments
} elseif ($Role -eq 'Capture') {
    $env:PLAYWRIGHT_BROWSERS_PATH = $config.browserPath
    $arguments = @((Join-Path $repo 'local/capture.mjs'), "--manifest=$($config.manifest)", "--out=$($config.outbox)", "--rate=$($config.rate)", "--wait-ms=$($config.waitMs)", "--har=$($config.har)", "--speed=$($config.speed)")
    if ($config.adultConfirmed -eq $true) { $arguments += '--confirm-adult' }
    & $node @arguments
} elseif ($Role -eq 'Branches') {
    $secrets = Import-Clixml -LiteralPath (Join-Path $repo '.wrangler/deployment-secrets.xml')
    $env:HYBRID_FUZZER_URL = $config.workerUrl
    $env:HYBRID_INGEST_TOKEN = [Net.NetworkCredential]::new('', $secrets['INGEST_TOKEN']).Password
    $env:HYBRID_REVIEW_TOKEN = [Net.NetworkCredential]::new('', $secrets['REVIEW_TOKEN']).Password
    if (-not $env:HYBRID_INGEST_TOKEN -or -not $env:HYBRID_REVIEW_TOKEN) { throw 'Faltan credenciales privadas de ingesta o revisión.' }
    $env:PLAYWRIGHT_BROWSERS_PATH = $config.browserPath
    Remove-Variable secrets
    $arguments = @((Join-Path $repo 'local/round-runner.mjs'), "--manifest=$($config.manifest)", "--out=$($config.outbox)", '--watch', '--limit=5', '--interval-ms=15000', "--speed=$($config.speed)")
    if ($config.adultConfirmed -eq $true) { $arguments += '--confirm-adult' }
    & $node @arguments
} else {
    $secrets = Import-Clixml -LiteralPath (Join-Path $repo '.wrangler/deployment-secrets.xml')
    $env:HYBRID_FUZZER_URL = $config.workerUrl
    $env:HYBRID_INGEST_TOKEN = [Net.NetworkCredential]::new('', $secrets['INGEST_TOKEN']).Password
    if (-not $env:HYBRID_INGEST_TOKEN) { throw 'Falta la credencial privada de subida.' }
    Remove-Variable secrets
    & $node (Join-Path $repo 'local/sync.mjs') "--out=$($config.outbox)" --watch --interval-ms=10000
}
exit $LASTEXITCODE

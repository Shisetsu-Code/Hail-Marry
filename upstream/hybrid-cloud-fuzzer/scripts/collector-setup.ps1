# One-time LOCAL Windows bootstrap for a previously deployed Cloudflare review run.
# Never modifies Cloudflare tokens or replaces an existing collector configuration.
param(
    [string]$RunId = '',
    [string]$Manifest = '',
    [string]$WorkerUrl = '',
    [string]$Outbox = '',
    [string]$BrowserPath = '',
    [switch]$ConfirmAdult,
    [switch]$DynamicWorkers,
    [switch]$AutoUpdate,
    [string]$ProviderSources = '',
    [int]$MaxWorkers = 5,
    [int]$BrowserWorkers = 3,
    [switch]$ConfigureTokens
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$stateDir = Join-Path $repo '.local-state'
$configFile = Join-Path $stateDir 'collector-control.json'
$secretDir = Join-Path $repo '.wrangler'
$secretFile = Join-Path $secretDir 'deployment-secrets.xml'
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    if ($RunId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$') {
        throw 'Es obligatorio -RunId con el identificador EXACTO de la tanda en Cloudflare (p. ej. hybrid-pragmatic-20261019).'
    }
    if (-not $WorkerUrl) {
        $toml = Join-Path $repo 'wrangler.toml'
        if (-not (Test-Path -LiteralPath $toml)) { throw 'No hay wrangler.toml; especifica -WorkerUrl.' }
        $configToml = Get-Content -Raw -LiteralPath $toml
        if ($configToml -match '(?m)^OAUTH_ISSUER\s*=\s*"(https://[^"\r\n]+)"') { $WorkerUrl = $Matches[1] }
        else { throw 'No pude determinar la URL del Worker; especifica -WorkerUrl.' }
    }
    $url = $null
    if (-not [Uri]::TryCreate($WorkerUrl,[UriKind]::Absolute,[ref]$url) -or $url.Scheme -ne 'https' -or $url.UserInfo -or $url.Query -or $url.Fragment) {
        throw 'WorkerUrl debe ser una URL HTTPS de origen, sin credenciales ni query.'
    }
    $null = New-Item -ItemType Directory -Force -Path $stateDir
    if ($Manifest) {
        $manifestPath = (Resolve-Path -LiteralPath $Manifest -ErrorAction Stop).Path
        $source = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
        if ($source.runId -cne $RunId) { throw "El manifiesto tiene runId '$($source.runId)', distinto de '$RunId'." }
        if ($null -eq $source.games) { throw 'El manifiesto no contiene games.' }
    } else {
        # Existing Cloudflare classifications contain URLs or Pragmatic public-catalogue game IDs.
        $manifestPath = Join-Path $stateDir ("remote-$RunId.json")
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            $payload = @{runId=$RunId;games=@()} | ConvertTo-Json -Depth 4
            [IO.File]::WriteAllText($manifestPath,$payload,$utf8)
        }
    }
    if (-not $Outbox) { $Outbox = Join-Path $repo 'outbox' }
    if (-not $BrowserPath) {
        if ($env:PLAYWRIGHT_BROWSERS_PATH) { $BrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH }
        elseif ($env:LOCALAPPDATA) { $BrowserPath = Join-Path $env:LOCALAPPDATA 'ms-playwright' }
        else { $BrowserPath = '' }
    }
    if ($MaxWorkers -lt 1 -or $MaxWorkers -gt 24 -or $BrowserWorkers -lt 1 -or $BrowserWorkers -gt 8) {
        throw 'MaxWorkers debe ser 1..24 y BrowserWorkers 1..8.'
    }
    $config = @{
        manifest=[IO.Path]::GetFullPath($manifestPath)
        outbox=[IO.Path]::GetFullPath($Outbox)
        workerUrl=$url.AbsoluteUri.TrimEnd('/')
        browserPath=$BrowserPath
        rate=3
        waitMs=6500
        har='all'
        speed=1
        adultConfirmed=[bool]$ConfirmAdult
        dynamicWorkers=[bool]$DynamicWorkers
        autoUpdate=[bool]$AutoUpdate
        providerSourcesPath=$(if($ProviderSources){(Resolve-Path -LiteralPath $ProviderSources -ErrorAction Stop).Path}else{Join-Path $repo 'examples/provider-sources.json'})
        maxWorkers=$MaxWorkers
        browserWorkers=$BrowserWorkers
    }
    [IO.File]::WriteAllText($configFile,($config | ConvertTo-Json -Depth 5),$utf8)
    Write-Host "Configuracion local creada para runId=$RunId."
    if (-not $Manifest) { Write-Host 'Manifest remoto sin juegos iniciales: el ejecutor recorrera las clasificaciones existentes; Capture terminara sin abrir juegos nuevos.' }
} else {
    Write-Host 'Configuracion local existente preservada; no se sobrescribio.'
}

if ($ConfigureTokens -and -not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    if ($env:OS -ne 'Windows_NT') { throw 'Para proteger los tokens mediante DPAPI ejecuta este paso en Windows.' }
    $null = New-Item -ItemType Directory -Force -Path $secretDir
    Write-Host 'Introduce los tokens YA configurados en el Worker, no valores nuevos. No se mostraran ni se subiran a Git.'
    $ingest = Read-Host 'INGEST_TOKEN existente' -AsSecureString
    $review = Read-Host 'REVIEW_TOKEN existente' -AsSecureString
    if (-not $ingest.Length -or -not $review.Length) { throw 'Ambos tokens son obligatorios.' }
    @{INGEST_TOKEN=$ingest;REVIEW_TOKEN=$review} | Export-Clixml -LiteralPath $secretFile
    Write-Host 'Tokens existentes cifrados con DPAPI para este usuario de Windows.'
} elseif ($ConfigureTokens) {
    Write-Host 'Ya existe el archivo local de credenciales; se preservo sin cambios.'
}
if (-not (Test-Path -LiteralPath $secretFile -PathType Leaf)) {
    Write-Warning 'No existe .wrangler/deployment-secrets.xml: Start no podra conectar Sync/Branches. Recupera los tokens existentes y usa -ConfigureTokens.'
}
Write-Host 'Consulta estado: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Status'

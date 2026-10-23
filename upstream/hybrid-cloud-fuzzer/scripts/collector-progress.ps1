$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
try {
    $secrets = Import-Clixml -LiteralPath (Join-Path $repo '.wrangler/deployment-secrets.xml')
    $env:HYBRID_REVIEW_TOKEN = [Net.NetworkCredential]::new('', $secrets['REVIEW_TOKEN']).Password
    Remove-Variable secrets
    & (Get-Command node.exe -ErrorAction Stop).Source (Join-Path $repo 'local/progress-report.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar el progreso de Cloudflare.' }
    Remove-Item -LiteralPath (Join-Path $repo '.local-state/collector-progress-error.txt') -ErrorAction SilentlyContinue
} catch {
    [IO.File]::WriteAllText((Join-Path $repo '.local-state/collector-progress-error.txt'),$_.Exception.Message)
    exit 1
} finally { Remove-Item Env:HYBRID_REVIEW_TOKEN -ErrorAction SilentlyContinue }

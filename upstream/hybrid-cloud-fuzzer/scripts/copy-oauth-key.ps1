$ErrorActionPreference = 'Stop'
$secretFile = Join-Path $PSScriptRoot '../.wrangler/deployment-secrets.xml'
$secrets = Import-Clixml -LiteralPath $secretFile
if (-not $secrets['OAUTH_LOGIN_SECRET']) { throw 'No se encontró la clave OAuth de este despliegue.' }
$value = [Net.NetworkCredential]::new('', $secrets['OAUTH_LOGIN_SECRET']).Password
Set-Clipboard -Value $value
Remove-Variable value,secrets
Write-Output 'Clave de conexión copiada. Pegala únicamente en la página de autorización de Hybrid Cloud Fuzzer.'

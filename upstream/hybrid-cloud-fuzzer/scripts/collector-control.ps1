param(
    [ValidateSet('Menu','Start','Stop','Status')][string]$Action = 'Menu',
    [switch]$DynamicWorkers,
    [switch]$AutoUpdate,
    [switch]$KeepUpdater,
    [switch]$Graceful
)
$ErrorActionPreference = 'Stop'
$script:repo = Split-Path $PSScriptRoot -Parent
$script:worker = Join-Path $PSScriptRoot 'collector-worker.ps1'
$script:stateFile = Join-Path $script:repo '.local-state/collection-processes.json'
$script:settingsFile = Join-Path $script:repo '.local-state/collector-control.json'

function Read-CollectorRecord {
    $record = @{}
    if (Test-Path -LiteralPath $script:stateFile) {
        $value = Get-Content -Raw -LiteralPath $script:stateFile | ConvertFrom-Json
        foreach ($property in $value.PSObject.Properties) { $record[$property.Name] = $property.Value }
    }
    return $record
}
function Save-CollectorRecord([hashtable]$Record) {
    # A new checkout has no .local-state directory (it is intentionally gitignored).
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $script:stateFile)
    $temporary = $script:stateFile + '.' + $PID + '.tmp'
    $json = $Record | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($temporary,$json,(New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $script:stateFile -Force
}
function Get-ManagedWorker([ValidateSet('Capture','Sync','Branches','Workforce','Updater')][string]$Role,[hashtable]$Record) {
    $key = $Role.ToLowerInvariant()
    $workerId = $Record[$key + 'Pid']
    $created = $Record[$key + 'StartedAt']
    if (-not $workerId -or -not $created) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$workerId)" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.CommandLine -notmatch [regex]::Escape($script:worker) -or $process.CommandLine -notmatch ('-Role\s+"?' + $Role + '\b')) { return $null }
    if ($process.CreationDate.ToString('o') -ne $created) { return $null }
    return $process
}
function Get-CollectorStatus {
    $record = Read-CollectorRecord
    $capture = Get-ManagedWorker -Role Capture -Record $record
    $sync = Get-ManagedWorker -Role Sync -Record $record
    $branches = Get-ManagedWorker -Role Branches -Record $record
    $workforce = Get-ManagedWorker -Role Workforce -Record $record
    $updater = Get-ManagedWorker -Role Updater -Record $record
    $configPresent = Test-Path -LiteralPath $script:settingsFile -PathType Leaf
    $secretsPresent = Test-Path -LiteralPath (Join-Path $script:repo '.wrangler/deployment-secrets.xml') -PathType Leaf
    $isDynamic = $false
    $isAutoUpdate = $false
    $continuationOnly = $false
    if ($configPresent) {
        try {
            $c = Get-Content -Raw -LiteralPath $script:settingsFile | ConvertFrom-Json
            $isDynamic = ($c.dynamicWorkers -eq $true)
            $isAutoUpdate = ($c.autoUpdate -eq $true)
            $continuationOnly = ($c.continuationOnly -eq $true)
        } catch {}
    }
    return [PSCustomObject]@{continuationOnly=$continuationOnly;captureRunning=[bool]$capture;syncRunning=[bool]$sync;branchesRunning=[bool]$branches;workforceRunning=[bool]$workforce;updaterRunning=[bool]$updater;updaterPid=$(if($updater){$updater.ProcessId}else{$null});autoUpdateConfigured=[bool]$isAutoUpdate;workforcePid=$(if($workforce){$workforce.ProcessId}else{$null});dynamicWorkersConfigured=[bool]$isDynamic;branchesPid=$(if($branches){$branches.ProcessId}else{$null});capturePid=$(if($capture){$capture.ProcessId}else{$null});syncPid=$(if($sync){$sync.ProcessId}else{$null});configPresent=[bool]$configPresent;secretsPresent=[bool]$secretsPresent}
}
function Start-Collector {
    if (-not (Test-Path -LiteralPath $script:settingsFile -PathType Leaf)) {
        throw 'Falta la configuracion local. Ejecuta: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-setup.ps1 -RunId TU_RUN_ID'
    }
    $config = Get-Content -Raw -LiteralPath $script:settingsFile | ConvertFrom-Json
    if (-not $config.manifest -or -not (Test-Path -LiteralPath $config.manifest -PathType Leaf)) { throw 'No se encuentra el catalogo de juegos configurado; comprueba .local-state/collector-control.json.' }
    $manifest = Get-Content -Raw -LiteralPath $config.manifest | ConvertFrom-Json
    if (-not $manifest.runId) { throw 'El manifiesto local no contiene runId.' }
    $secretPath = Join-Path $script:repo '.wrangler/deployment-secrets.xml'
    if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
        throw 'Faltan credenciales DPAPI locales (el git pull no las restaura). Si tienes los tokens existentes, ejecuta collector-setup.ps1 -ConfigureTokens; NO cambies los secretos del Worker.'
    }
    try {
        $localSecrets = Import-Clixml -LiteralPath $secretPath
        if (-not $localSecrets['INGEST_TOKEN'] -or -not $localSecrets['REVIEW_TOKEN']) { throw 'Claves de ingesta/revision ausentes' }
    } catch { throw 'Las credenciales DPAPI locales no son legibles por este usuario; recupera los tokens existentes en lugar de rotarlos automaticamente.' }
    Remove-Variable localSecrets
    $record = Read-CollectorRecord
    if ($DynamicWorkers -and $config.dynamicWorkers -ne $true) {
        # Mode changes require an explicit Stop. Never launch two branch runners.
        if ((Get-ManagedWorker -Role Branches -Record $record) -or (Get-ManagedWorker -Role Capture -Record $record)) {
            throw 'Deten los procesos legados con -Action Stop antes de activar -DynamicWorkers.'
        }
        $config | Add-Member -NotePropertyName dynamicWorkers -NotePropertyValue $true -Force
        [IO.File]::WriteAllText($script:settingsFile,($config | ConvertTo-Json -Depth 8),(New-Object System.Text.UTF8Encoding($false)))
    }
    if ($AutoUpdate -and $config.autoUpdate -ne $true) {
        $config | Add-Member -NotePropertyName autoUpdate -NotePropertyValue $true -Force
        [IO.File]::WriteAllText($script:settingsFile,($config | ConvertTo-Json -Depth 8),(New-Object System.Text.UTF8Encoding($false)))
    }
    if (($config.dynamicWorkers -ne $true) -and (Get-ManagedWorker -Role Workforce -Record $record)) {
        throw 'Deten Workforce antes de volver al modo legado.'
    }
    $hostPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $roles = if ($config.continuationOnly -eq $true) { @('Branches') } elseif ($config.dynamicWorkers -eq $true) { @('Sync','Workforce') } else { @('Sync','Branches','Capture') }
    if ($config.autoUpdate -eq $true) { $roles += 'Updater' }
    foreach ($role in $roles) {
        if (Get-ManagedWorker -Role $role -Record $record) { continue }
        $key = $role.ToLowerInvariant()
        if ($record[$key+'Pid'] -and (Get-Process -Id ([int]$record[$key+'Pid']) -ErrorAction SilentlyContinue)) { throw 'Un PID guardado pertenece a otro proceso; no se modifico.' }
        $logPath = Join-Path $script:repo ('.local-state/' + $key + '-managed')
        $process = Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$script:worker+'"'),'-Role',$role) -WorkingDirectory $script:repo -WindowStyle Hidden -RedirectStandardOutput ($logPath+'.stdout.log') -RedirectStandardError ($logPath+'.stderr.log') -PassThru
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
        if (-not $details) { throw "No se pudo iniciar $role. Revisar sus registros." }
        $record[$key+'Pid'] = $process.Id
        $record[$key+'StartedAt'] = $details.CreationDate.ToString('o')
        Save-CollectorRecord $record
    }
}
function Stop-Collector([switch]$KeepUpdater,[switch]$Graceful) {
    $record = Read-CollectorRecord
    $deadline = (Get-Date).AddSeconds(300)
    foreach ($role in @('Updater','Workforce','Branches','Capture','Sync')) {
        if ($role -eq 'Updater' -and $KeepUpdater) { continue }
        $process = Get-ManagedWorker -Role $role -Record $record
        $key = $role.ToLowerInvariant()
        if ($process) {
            if ($Graceful) {
                # The updater has created update-drain.flag. Each managed worker
                # must exit at its task boundary; never interrupt a DEMO click.
                while ($process -and (Get-Date) -lt $deadline) {
                    Start-Sleep -Milliseconds 500
                    $process = Get-ManagedWorker -Role $role -Record $record
                }
                if ($process) { throw "Worker $role sigue ocupado. Se pospone la actualizacion sin forzar acciones." }
            } else {
                # Explicit operator stop retains the original verified PID safety.
                $nativeProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
                $null = & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F 2>&1
                if ($nativeProcess -and -not $nativeProcess.WaitForExit(10000)) { throw "No se pudo detener $role." }
            }
        } elseif ($record[$key+'Pid'] -and (Get-Process -Id ([int]$record[$key+'Pid']) -ErrorAction SilentlyContinue)) {
            throw 'El PID guardado pertenece a otro proceso; no se detuvo.'
        }
        $record.Remove($key+'Pid'); $record.Remove($key+'StartedAt')
        Save-CollectorRecord $record
    }
}
function Invoke-CollectorAction([string]$RequestedAction) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $name = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:repo.ToLowerInvariant())))).Replace('-','') } finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\HybridCollector'+$name))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Ya hay otra operacion del recopilador en curso.' }
        if ($RequestedAction -eq 'Start') { Start-Collector }
        elseif ($RequestedAction -eq 'Stop') { Stop-Collector -KeepUpdater:$KeepUpdater -Graceful:$Graceful }
    } finally { if ($acquired) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
function Show-CollectorMenu {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'Recopilador Hybrid Fuzzer'; $form.ClientSize = New-Object Drawing.Size(1140,820)
    $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
    $label = New-Object Windows.Forms.Label
    $label.Location = New-Object Drawing.Point(24,22); $label.Size = New-Object Drawing.Size(420,76)
    $label.Font = New-Object Drawing.Font('Segoe UI',12)
    $form.Controls.Add($label)
    $note = New-Object Windows.Forms.Label
    $note.Location = New-Object Drawing.Point(24,150); $note.Size = New-Object Drawing.Size(1090,50)
    $note.Text = "Cerrar esta ventana deja el motor funcionando. Progreso de Cloudflare cada 30 segundos.`r`nCompras/Ante/Elecciones = controles clasificados distintos. Finalizado = peticion DEMO observada, sin pendientes ni bloqueos; no valida el juego completo."
    $form.Controls.Add($note)
    $start = New-Object Windows.Forms.Button; $start.Text = 'Iniciar'; $start.Location = New-Object Drawing.Point(24,95); $start.Size = New-Object Drawing.Size(130,44)
    $stop = New-Object Windows.Forms.Button; $stop.Text = 'Detener'; $stop.Location = New-Object Drawing.Point(170,95); $stop.Size = New-Object Drawing.Size(130,44)
    $close = New-Object Windows.Forms.Button; $close.Text = 'Cerrar'; $close.Location = New-Object Drawing.Point(316,95); $close.Size = New-Object Drawing.Size(130,44)
    $form.Controls.AddRange(@($start,$stop,$close))
    $progressLabel = New-Object Windows.Forms.Label
    $progressLabel.Location = New-Object Drawing.Point(24,205); $progressLabel.Size = New-Object Drawing.Size(1090,25)
    $progressLabel.Text = 'Consultando progreso de Cloudflare...'; $form.Controls.Add($progressLabel)
    function New-ProgressGrid($columns,$y,$height) {
        $grid = New-Object Windows.Forms.DataGridView
        $grid.Location = New-Object Drawing.Point(24,$y); $grid.Size = New-Object Drawing.Size(1090,$height)
        $grid.ReadOnly = $true; $grid.AllowUserToAddRows = $false; $grid.AllowUserToDeleteRows = $false
        $grid.RowHeadersVisible = $false; $grid.AutoSizeColumnsMode = 'Fill'; $grid.SelectionMode = 'FullRowSelect'
        foreach ($column in $columns) { $null = $grid.Columns.Add($column[0],$column[1]) }
        $form.Controls.Add($grid)
        return ,$grid
    }
    $providerColumns = @(@('provider','Proveedor'),@('total','Juegos'),@('processed','Procesados'),@('finished','Finalizados'),@('unfinished','Sin finalizar'),@('pending','Pendientes'),@('review','Revision'),@('buys','Compras'),@('anteBets','Ante bet'),@('choices','Elecciones'))
    $providerGrid = New-ProgressGrid $providerColumns 235 140
    $filterLabel = New-Object Windows.Forms.Label
    $filterLabel.Text = 'Filtrar proveedor o juego:'; $filterLabel.Location = New-Object Drawing.Point(24,391); $filterLabel.Size = New-Object Drawing.Size(180,25)
    $form.Controls.Add($filterLabel)
    $filter = New-Object Windows.Forms.TextBox
    $filter.Location = New-Object Drawing.Point(210,388); $filter.Size = New-Object Drawing.Size(430,25); $form.Controls.Add($filter)
    $gameColumns = @(@('provider','Proveedor'),@('gameId','Juego'),@('state','Estado'),@('captures','Capturas'),@('classified','Clasificadas'),@('pending','Pendientes'),@('review','Revision'),@('buys','Compras'),@('anteBets','Ante bet'),@('choices','Elecciones'),@('navigation','Continuar'),@('other','Otros'),@('executed','Ramas hechas'),@('remainingActions','Ramas pendientes'),@('blocked','Bloqueos'),@('uncertain','Inciertas'))
    $gameGrid = New-ProgressGrid $gameColumns 430 365
    $gameGrid.AutoSizeColumnsMode = 'None'
    foreach ($column in $gameGrid.Columns) { $column.Width = 88 }
    $gameGrid.Columns['provider'].Width = 100; $gameGrid.Columns['gameId'].Width = 245; $gameGrid.Columns['state'].Width = 245
    $gameGrid.Columns['provider'].Frozen = $true; $gameGrid.Columns['gameId'].Frozen = $true
    $gameGrid.ColumnHeadersHeight = 44
    $form.Tag = @{lastFetch=[datetime]::MinValue;lastVersion='';report=$null;progressProcess=$null}
    $renderGames = {
        $gameGrid.Rows.Clear()
        $term = $filter.Text.Trim()
        foreach ($game in $form.Tag.report.games) {
            if ($term -and ($game.provider+'/'+$game.gameId).IndexOf($term,[StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
            $values = @($gameColumns | ForEach-Object { $game.($_[0]) })
            $null = $gameGrid.Rows.Add([object[]]$values)
        }
    }
    $filter.Add_TextChanged({ & $renderGames })
    $refresh = {
        try { $status = Get-CollectorStatus
            if ($status.dynamicWorkersConfigured) {
                $label.Text = 'Workers dinamicos: ' + $(if($status.workforceRunning){'en marcha'}else{'detenidos'}) + "`r`n" + 'Sincronizacion: ' + $(if($status.syncRunning){'en marcha'}else{'detenida'})
            } else {
                $label.Text = 'Captura: ' + $(if($status.captureRunning){'en marcha'}else{'detenida'}) + "`r`n" + 'Sincronizacion: ' + $(if($status.syncRunning){'en marcha'}else{'detenida'}) + "`r`n" + 'Ramas: ' + $(if($status.branchesRunning){'en marcha'}else{'detenida'})
            }
            $start.Enabled = if($status.continuationOnly){-not $status.branchesRunning}elseif($status.dynamicWorkersConfigured){-not ($status.workforceRunning -and $status.syncRunning)}else{-not ($status.captureRunning -and $status.syncRunning -and $status.branchesRunning)}
            $stop.Enabled = $status.updaterRunning -or $status.workforceRunning -or $status.captureRunning -or $status.syncRunning -or $status.branchesRunning
            $progressFile = Join-Path $script:repo '.local-state/collector-progress.json'
            if (Test-Path -LiteralPath $progressFile) {
                $report = Get-Content -Raw -LiteralPath $progressFile | ConvertFrom-Json
                if ($form.Tag.lastVersion -ne $report.updatedAt) {
                    $form.Tag.report = $report; $form.Tag.lastVersion = $report.updatedAt
                    $providerGrid.Rows.Clear()
                    foreach ($provider in $report.providers) {
                        $values = @($providerColumns | ForEach-Object { $provider.($_[0]) })
                        $null = $providerGrid.Rows.Add([object[]]$values)
                    }
                    & $renderGames
                }
                $progressLabel.Text = 'Tanda: '+$report.runId+' | Actualizado: '+$report.updatedAt+' | Juegos: '+$report.games.Count
            }
            $errorFile = Join-Path $script:repo '.local-state/collector-progress-error.txt'
            if (Test-Path -LiteralPath $errorFile) { $progressLabel.Text = 'Progreso sin actualizar: '+(Get-Content -Raw -LiteralPath $errorFile) }
            $progressProcess = $form.Tag.progressProcess
            if (((Get-Date)-$form.Tag.lastFetch).TotalSeconds -ge 30 -and (-not $progressProcess -or $progressProcess.HasExited)) {
                $hostPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
                $progressScript = Join-Path $PSScriptRoot 'collector-progress.ps1'
                $form.Tag.progressProcess = Start-Process -FilePath $hostPath -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$progressScript+'"')) -WindowStyle Hidden -WorkingDirectory $script:repo -PassThru
                $form.Tag.lastFetch = Get-Date
            }
        } catch { $label.Text = 'Error al consultar el estado.' }
    }
    $start.Add_Click({ try { Invoke-CollectorAction 'Start'; & $refresh } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Recopilador') | Out-Null } })
    $stop.Add_Click({ try { Invoke-CollectorAction 'Stop'; & $refresh } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Recopilador') | Out-Null } })
    $close.Add_Click({$form.Close()})
    $timer = New-Object Windows.Forms.Timer; $timer.Interval = 3000; $timer.Add_Tick($refresh)
    $form.Add_Shown({ & $refresh; $timer.Start() })
    try { $null = $form.ShowDialog() } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
}
if ($MyInvocation.InvocationName -ne '.') {
    if ($Action -eq 'Menu') { Show-CollectorMenu }
    else { if ($Action -ne 'Status') { Invoke-CollectorAction $Action }; Get-CollectorStatus | ConvertTo-Json -Compress }
}

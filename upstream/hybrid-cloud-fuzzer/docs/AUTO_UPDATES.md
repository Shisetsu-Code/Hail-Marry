# Actualizaciones automáticas desde GitHub main

Hay dos mecanismos distintos. El despliegue remoto se ejecuta en GitHub Actions y el actualizador local funciona únicamente mientras el recopilador esté encendido en Windows.

## 1. Configurar una sola vez el despliegue de Cloudflare

GitHub contiene el workflow .github/workflows/deploy-cloudflare.yml. Se activa al subir o fusionar cambios de Worker, esquema o dependencias en main. Primero ejecuta npm ci, npm run check y npm test; después aplica migraciones D1 remotas, despliega el Worker y verifica /health con schemaVersion >= 4, workforceReady=true y pacingReady=true.

Por seguridad el despliegue está desactivado inicialmente hasta configurar estas opciones en el repositorio (Settings > Secrets and variables > Actions):

- Secret: CLOUDFLARE_API_TOKEN, token de API del usuario con permisos para desplegar Workers y modificar la base D1 utilizada.
- Secret: CLOUDFLARE_ACCOUNT_ID, identificador de la cuenta de Cloudflare.
- Variable de repositorio: ENABLE_CF_GITHUB_DEPLOY = true.

No introduzcas tokens en el repositorio, en archivos de configuración rastreados ni en esta conversación. La conexión previa Cloudflare Builds puede desplegar también el mismo Worker. **Antes de activar el deploy de GitHub Actions, deshabilitá el despliegue automático de Cloudflare Builds para este Worker**, así hay un único mecanismo publicando versiones y migraciones. Después ejecutá el workflow una vez con Actions > Deploy Cloudflare (main) > Run workflow (o esperá la siguiente modificación de main).

Si los secretos o la variable todavía no están configurados, el job queda omitido; un push de GitHub **no implica** que Cloudflare ya esté actualizado. Los workers locales no se actualizan si la versión remota necesaria todavía no está lista.

## 2. Activar el actualizador local de Windows

Después de actualizar el repositorio manualmente una última vez:

~~~powershell
cd $HOME\hybrid-cloud-fuzzer
git pull --ff-only
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Start -AutoUpdate
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-control.ps1 -Action Status
~~~

Si ya estás usando workers dinámicos, se conserva el valor dynamicWorkers. No hace falta volver a indicar -DynamicWorkers. El cambio -AutoUpdate queda almacenado solamente en .local-state/collector-control.json (excluido de Git) para los siguientes inicios. Si creás una instalación nueva, collector-setup.ps1 también acepta -AutoUpdate.

El proceso Updater consulta GitHub main cada **120 segundos** mientras Windows y el controlador estén activos. Ante un nuevo commit:

1. Verifica que origin apunte exactamente a Shisetsu-Code/hybrid-cloud-fuzzer, que la rama local sea main, que el árbol esté limpio y que el cambio sea fast-forward. Nunca usa force pull, reset, stash ni borra cambios del usuario.
2. Exige que /health de Cloudflare esté listo con la versión de esquema D1 requerida por el commit de destino. Si no, posterga el reinicio.
3. Comprueba la versión candidata en un Git worktree temporal ignorado por Git, con npm ci, npm run check y npm test; los procesos de captura siguen trabajando durante esta fase.
4. Crea un marcador de drenaje. Sync, Capture, Branches y Workforce terminan la tarea que estaban ejecutando y salen de forma cooperativa; el actualizador espera hasta cinco minutos y, si hay una tarea larga, **pospone la actualización sin forzarla**.
5. Hace fast-forward, instala dependencias y vuelve a arrancar los procesos del recopilador. Mantiene el runId, la configuración local, la cola D1, los HAR, las capturas y el journal. No rota ni abre las credenciales DPAPI.

Consulta el estado:

~~~powershell
Get-Content .\.local-state\auto-update-status.json
Get-Content .\.local-state\updater-managed.stdout.log -Tail 40
~~~

Para consultar manualmente si hay una nueva versión sin aplicar cambios:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\collector-update.ps1 -Once -CheckOnly
~~~

El comando -Action Stop sin opciones también detiene al actualizador. El servicio se reanuda al pulsar Iniciar, que usa la configuración autoUpdate previamente guardada.

## Límites

- Se actualiza el **código** y se aplican migraciones aditivas de D1, no se migran automáticamente sesiones, juegos fallidos o decisiones de clasificación.
- Las imágenes visuales continúan requiriendo un clasificador MCP. Los agentes estructurados mantienen sus controles de calidad.
- Los workers de Cloudflare no pueden reiniciar procesos en tu PC. El actualizador local necesita Windows encendido y el proceso Updater activo; si el PC está apagado, se pondrá al día cuando vuelvas a iniciar el recopilador.
- Si hay cambios locales, diverge la rama, no se puede verificar GitHub/Cloudflare o fallan las pruebas, la actualización se difiere y se registra el error. No se fuerza una actualización incompatible.
- La automatización no reemplaza la revisión de cambios potencialmente peligrosos que lleguen a main. Protegé main con revisión y comprobaciones CI obligatorias.

Para desplegar también la flota de 8 GitHub Actions runners, seguir el [runbook completo para Codex](https://github.com/Shisetsu-Code/Hybrid-actions/blob/main/docs/CODEX_DEPLOY_RUNBOOK.md); este actualizador local de Windows no sustituye la migración D1 ni la configuración de secretos del segundo repositorio.

# CODEX — despliegue del coordinador Cloudflare y la flota Hybrid-actions

**Guía canónica y actualizada (ambos repositorios):**
https://github.com/Shisetsu-Code/Hybrid-actions/blob/main/docs/CODEX_DEPLOY_RUNBOOK.md

Leé también AGENTS.md de los dos repositorios. Este archivo sustituye las instrucciones anteriores que trataban el esquema D1 versión 2 como objetivo y describían Workers Builds como único publicador. No eliminar los recursos ni las capturas del Worker existente.

## Encargo concreto

Hacer que **Shisetsu-Code/hybrid-cloud-fuzzer** (Worker/D1/R2/MCP) funcione con **Shisetsu-Code/Hybrid-actions** (8 runners de GitHub Actions, hasta 5–6 demos de proveedores distintos por runner, 60 minutos o hasta agotar el catálogo), con límite por proveedor global en D1. Terminar con evidencias reales y estados claros. No son objetivos del deploy las compras, giros ni apuestas, la reejecución de partidas históricas, o la clasificación visual automática de imágenes no revisadas.

### Código y esquemas

- Rama fuente: **main** de ambos repositorios; verificar SHA real con git rev-parse HEAD.
- El motor está publicado en el repositorio; NO hay ZIP ni rama de imágenes que importar para desplegarlo.
- En wrangler.toml están definidos Worker hybrid-cloud-fuzzer, D1 DB hybrid-cloud-fuzzer, R2 IMAGES hybrid-fuzzer-images y KV OAUTH_KV. Conservar todos sus identificadores.
- Migraciones D1: **0001**, **0002**, **0003** (workforce), **0004** (provider_policies/provider_sessions).
- El Worker debe publicar /health con ok=true, schemaVersion **>=4**, workforceReady=true y pacingReady=true.
- La API de tareas distribuidas está protegida con REVIEW_TOKEN: /v1/work/jobs, /v1/work/claim, /v1/work/renew, /v1/work/finish, /v1/work/defer, /v1/work/stats, /v1/work/providers, /v1/work/provider/*.
- MCP conserva /mcp y OAuth; no confundir MCP_TOKEN, OAUTH_LOGIN_SECRET, REVIEW_TOKEN, INGEST_TOKEN.

### Estado remoto observado (histórico, debe volver a verificarse)

Último workflow Verify Cloudflare production inspeccionado: run **39444253017** (2026-10-20 14:59 UTC), reportó **schemaVersion 2**. El job Deploy Cloudflare (main) asociado estaba **skipped**. Por lo tanto no declarar migración 0004 aplicada ni despliegue completo sin nuevas pruebas. Consultar /health y jobs de producción directamente al ejecutar el handoff; el estado podría haber cambiado.

### Secuencia mínima

1. Comprobar acceso a las dos ramas main y ejecutar npm ci, npm run check, npm test en hybrid-cloud-fuzzer; npm run check y npm test, incluido browser-smoke, en Hybrid-actions.
2. Elegir un solo mecanismo de publicación para Worker hybrid-cloud-fuzzer: GitHub Actions Deploy Cloudflare (main) **o** Cloudflare Workers Builds (nunca dos publicadores concurrentes). Comprobar si la configuración de despliegue y secretos está accesible.
3. Confirmar cuenta Cloudflare real y bindings sin sustituirlos. Crear/verificar respaldo recuperable D1, en almacenamiento privado.
4. Aplicar migraciones REMOTAS sin tocar los datos previos. Verificar por migraciones y nombres de tablas.
5. Publicar el Worker desde main, comprobar SHA/resultado del publicador, /health >=4 y los indicadores workforceReady/pacingReady.
6. Probar MCP con scripts/verify-deployment.mjs y, opcionalmente si el operador dispone de la clave, scripts/verify-oauth.mjs. Son checks de lectura, salvo la verificación OAuth que crea/revoca un grant de prueba. Nunca imprimir secretos.
7. En Hybrid-actions configurar los GitHub secrets HYBRID_REVIEW_TOKEN/HYBRID_INGEST_TOKEN usando los valores YA existentes de Cloudflare (si Codex no puede escribir secretos, pedir al propietario que los configure en la UI).
8. Habilitar únicamente proveedores **autorizados y con URLs de DEMO verificadas** en config/providers.json. El archivo empieza intencionalmente con providers=[]; no hay tarea real hasta configurar al menos un proveedor. Conservar runId hybrid-actions-20261020 y los IDs históricos.
9. Ejecutar primer piloto manual en https://github.com/Shisetsu-Code/Hybrid-actions/actions/workflows/catalog.yml, per_runner=5, duration_minutes=15, confirm_adult=false (salvo aprobación específica). Esperar matrix, report, D1/R2 reales y tasas por proveedor.
10. Si los datos confirman éxito y límites correctos, habilitar ENABLE_RECURRING_CATALOG=true en **Hybrid-actions** para continuar cada hora hasta agotar el trabajo automatizable. La cola visual/híbrida requiere clasificación MCP aparte.

### Comandos de referencia (Cloudflare)

~~~powershell
cd hybrid-cloud-fuzzer
git pull --ff-only
npm ci --ignore-scripts
npm run check
npm test
npx wrangler whoami
npx wrangler d1 list
npx wrangler r2 bucket list
npx wrangler d1 migrations list hybrid-cloud-fuzzer --remote
# PRECONDICIÓN: respaldo D1 recuperable confirmado
npx wrangler d1 migrations apply hybrid-cloud-fuzzer --remote
npx wrangler d1 migrations list hybrid-cloud-fuzzer --remote
# SOLO si la opción elegida es Wrangler y el otro publicador está desactivado:
npx wrangler deploy
~~~

Nunca ejecutar cambios sobre un repositorio equivocado, reemplazar tokens, modificar IDs de R2/D1/KV o mezclar entornos --local y --remote. No ejecutar npx wrangler deploy adicionalmente si GitHub Actions ya publicó esa revisión. El runbook canónico contiene el procedimiento completo de seguridad, secretos, backup, verificación y rollback.

### Control del deploy automático

El workflow .github/workflows/deploy-cloudflare.yml está disponible pero **solo corre** con Repository variable ENABLE_CF_GITHUB_DEPLOY=true en hybrid-cloud-fuzzer y los secrets CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID configurados. El environment production puede tener aprobación manual. Un job skipped **no** cuenta como publicación. No volver a activar Cloudflare Builds en paralelo.

### Criterios de éxito

- Worker /health con version 4, estado correcto de D1/R2, sin pérdida de datos.
- D1 con las siete tablas esperadas: items, decision_history, action_traces, workforce_jobs, workforce_agents, provider_policies, provider_sessions.
- MCP tools/list funcional bajo autenticación, sin ejecutar compras.
- Hybrid-actions CI (Node 22/24 y Chromium) verde, secretos presentes y al menos un proveedor autorizado con catálogo real.
- Workflow manual prepare y runners ejecutados si había backlog; capturas JPG consultables en R2 y metadatos de D1 bajo el run correcto.
- Métricas por proveedor y backlog visual reportados; recurrencia solamente después de piloto.
- Si algo falta, comunicar bloqueo exacto en lugar de afirmar éxito.

### Compatibilidad/rollback

No tocar el Cloud-Fuzzer antiguo, Fuzzer-Manual, otros Workers, claves anteriores ni bases ajenas. No borrar/rehacer D1. Las migraciones aditivas NO se revierten al cambiar código. Detener la recurrencia poniendo ENABLE_RECURRING_CATALOG=false, deshabilitar las políticas de los proveedores afectados si fuera necesario y esperar que expiren las sesiones antes de revertir un Worker a una versión compatible. Nunca reejecutar una compra ante incertidumbre sobre el primer clic.

**Informe final de Codex:** SHA de ambas ramas, resultados CI, estado de backups, migraciones D1, SHA/URL/health real del Worker, comprobación MCP, disponibilidad de secretos (sin valores), proveedores aprobados, IDs de workflows, evidencia D1/R2, pendientes visuales, recurrencia y bloqueos.

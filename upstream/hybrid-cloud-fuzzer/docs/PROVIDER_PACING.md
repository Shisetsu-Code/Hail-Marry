# Coordinación de sesiones por proveedor (GitHub Actions)

El repositorio `Shisetsu-Code/Hybrid-actions` utiliza el plano de control D1 y R2 de este motor. La migración aditiva `0004_provider_pacing.sql` introduce políticas explícitas por proveedor: intervalo mínimo entre **inicios de sesiones** y número máximo de sesiones simultáneas, compartidos por todas las máquinas, ejecuciones y lotes.

Para cada proveedor autorizado hay que configurar `provider`, `minStartIntervalMs`, `maxActive` y `enabled` mediante `POST /v1/work/provider/policy` (token REVIEW). Un proveedor sin política habilitada **no puede abrir juegos**: no existe un límite global fijo de tres por minuto. Los ejemplos son valores conservadores de operación y **no** representan límites oficiales impuestos por un proveedor. Los controles siguen bajo responsabilidad del operador de cada demo.

El nuevo flujo es `GET /v1/work/provider/policies`, `GET /v1/work/providers?runId=...`, `POST /v1/work/provider/lease`, `POST /v1/work/provider/renew` y `POST /v1/work/provider/release`. Cada reserva consume una ventana de inicio global mediante una actualización atómica D1 y comprueba sesiones activas. Cada agente renueva su propia sesión y la libera al terminar; los leases vencidos dejan de computarse cuando un proceso se cae. Los endpoints requieren REVIEW_TOKEN. Las colas de captura/clasificación y las capturas existentes permanecen intactas.

Despliegue: fusionar los cambios a `main`, aplicar `npx wrangler d1 migrations apply hybrid-cloud-fuzzer --remote`, publicar con `npx wrangler deploy` o el workflow de despliegue autorizado, y verificar `/health` con `schemaVersion: 4` y `pacingReady: true`. El código de `Hybrid-actions` no debe ejecutar trabajos reales hasta esa verificación. La migración 0004 no modifica las clasificaciones previamente guardadas.

El procedimiento verificable para el despliegue coordinado con Hybrid-actions, los secretos, el piloto, la reanudación y la respuesta final de Codex está en [CODEX_DEPLOY_RUNBOOK.md](https://github.com/Shisetsu-Code/Hybrid-actions/blob/main/docs/CODEX_DEPLOY_RUNBOOK.md). Verificar en producción el esquema **>=4** antes de habilitar tickets.

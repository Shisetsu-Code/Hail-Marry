# Hybrid Fuzzer MCP — integración y clasificación rápida

## ChatGPT: conexión con OAuth

URL desplegada: `https://hybrid-cloud-fuzzer.braian-n-l.workers.dev/mcp`.
Agregar un servidor MCP personalizado y elegir **OAuth**. No ingresar el
`MCP_TOKEN` en ChatGPT ni configurar un client secret manualmente: el servidor
admite Client ID Metadata Documents y registro dinámico de clientes.

Al conectar, se abre la página de Hybrid Cloud Fuzzer. Verificar el nombre del
cliente y el dominio de destino, ingresar la **clave privada de conexión** y
pulsar **Autorizar**. Es una clave independiente de Cloudflare y de ChatGPT;
el operador la configura como secreto `OAUTH_LOGIN_SECRET` (32 caracteres o más,
generados al azar). En el equipo del despliegue, `scripts/copy-oauth-key.ps1`
copia la clave cifrada con Windows DPAPI al portapapeles sin mostrarla.

OAuth usa authorization code con PKCE S256 para clientes públicos, access tokens
de una hora y refresh tokens rotatorios con duración máxima de 30 días. El
consentimiento queda ligado al navegador y el grant solo permite acceso al MCP;
no habilita `/v1/items` ni la API de revisión. El almacenamiento OAuth usa el
binding `OAUTH_KV`, separado de las capturas y del Cloud-Fuzzer anterior.

Para verificar un despliegue: `npm run verify:oauth`, con `HYBRID_FUZZER_URL`
y `HYBRID_OAUTH_LOGIN_SECRET` en el entorno privado. Crea un cliente de prueba,
comprueba PKCE, renovación y MCP, y revoca su grant al terminar.

## Clientes con token Bearer o stdio

**Remoto**: `https://<YOUR_SUBDOMAIN>.workers.dev/mcp` (HTTP POST stateless).
Header `Authorization: Bearer <MCP_TOKEN>`. Solo el operador debe conocer el token.

**Codex stdio**: iniciar `node mcp/stdio.mjs` con estas variables de entorno
protegidas, nunca persistidas en Git:

- `HYBRID_FUZZER_URL` = URL completa del Worker, sin `/mcp`.
- `HYBRID_MCP_TOKEN` = valor privado de `MCP_TOKEN` guardado en Cloudflare.

Conectar el ejecutable como servidor MCP stdio desde la configuración de Codex.
Si el cliente admite MCP remoto stateless con Bearer, usar `/mcp` directamente.
La conexión debe probarse con `initialize` y `tools/list`, **no solo `/health`**.

## Bucle rápido recomendado

1. `next_item({runId,leaseSeconds:300})` → una lista compacta de candidatos.
2. Si `mode=structured`, decidir IDs sin abrir una imagen.
3. Si `mode=hybrid/visual`, revisar el JPEG y agregar coordenadas normalizadas.
4. `save_and_next` con los mismos `id`, `leaseId`, `revision`, `sourceSha256` y
   **todas** las selecciones/marks de esa pantalla, más `runId` para reclamar la
   siguiente dentro de la misma llamada.
5. Repetir usando `next.item`; si devuelve `next.empty=true`, terminar.

`save_classification` permanece disponible por compatibilidad.
`get_item({id,leaseId,includeImage:true})` entrega una captura de respaldo bajo
lease válido incluso cuando el elemento llegó en modo estructurado y se subió
una imagen opcional.

Estados permitidos: `classified` y `needs_review`. `needs_review` no es una
compra confirmada y se puede revisar manualmente después. Las marcas no se
convierten en clicks por sí mismas: el ejecutor local consume el feed D1 de
forma independiente y debe validar la versión de origen.

La clasificación dura menos al evitar imágenes completas y commits por cada
juego. No inventar métricas de velocidad: informar segundos reales por elemento.


## Auditar clasificaciones ya guardadas (sin exportar archivos)

El MCP lee directamente de Cloudflare D1: no es necesario ejecutar Wrangler,
descargar JSON ni volver a clasificar.

- `audit_classifications({runId:"hybrid-pragmatic-20261019",limit:20})`: lista
  clasificaciones persistidas con IDs, etiquetas, rutas de controles, rectángulos
  normalizados y decisiones; es de solo lectura.
- Para seguir: repetir con `afterId` igual a `nextAfterId` de la respuesta
  anterior, hasta que `hasMore=false`.
- `audit_item({id:"<id devuelto>",includeImage:true})`: consulta una clasificación
  anterior y, si existe, devuelve su JPEG privado desde R2 sin reclamar una tarea.
- `status:"needs_review"` permite revisar también los casos dudosos.
- `includeCandidates:false` reduce el volumen de datos para auditorías rápidas.

Estas herramientas no modifican D1, no crean leases y no ejecutan clicks.
Requieren la misma autenticación MCP/OAuth que el clasificador.

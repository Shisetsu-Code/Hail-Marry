# Captura guiada para el fuzzer

La persona reconoce el botón; el programa conserva su referencia, ejecuta el paso indicado y captura el resultado. Esto permite enseñar una ruta inicial y comprobar visualmente cada transición sin depender de OCR o de un modelo para ubicar los controles que ya reconociste.

## Uso

Entrá con el enlace que incluye la clave de acceso. El navegador retira la clave de la barra de direcciones y la conserva durante esa pestaña. Elegí un juego en la cola, esperá su captura, pulsá el atajo y hacé clic en el botón dentro de la imagen.

| Atajo | Qué marcás | Efecto |
| --- | --- | --- |
| **1** | Spin normal | Guarda su ubicación y referencia; no gira. |
| **2** | Activador de Antebet | Guarda y pulsa el activador, vuelve a comprobar el Spin marcado con 1 y hace una tirada. Requiere ese Spin en la misma sesión. |
| **3** | Menú de compras | Guarda y abre ese menú. Admite varios menús y submenús. |
| **4** | Compra directa | Guarda y pulsa la compra u opción de compra. |
| **5** | Único Spin del juego | Guarda Spin y finaliza esa captura sin pulsarlo. |
| **Q** | Continue inicial | Guarda el paso de entrada, pulsa Continue y muestra la pantalla siguiente. |

Los botones **Opción, Confirmar, Cancelar, Volver y Apuesta** permiten describir las pantallas posteriores. Los atajos eligen el tipo de marca; la posición se indica con el ratón o el dedo. Los atajos se desactivan mientras escribís una etiqueta.

**Solo marcar** guarda varias opciones de una misma pantalla sin abrirlas inmediatamente. En la lista de controles se puede ejecutar una marca que siga perteneciendo a la captura actual. Después de una transición, las marcas de la imagen anterior quedan como evidencia; para otra acción se utiliza la nueva captura. **Actualizar** toma una imagen nueva sin enviar un clic. **Finalizar y siguiente** guarda la clasificación y pasa al siguiente juego. En **Capturas guardadas** se inspeccionan imágenes anteriores sin operar sobre ellas.

Si una activación de Antebet muestra una pantalla intermedia, mueve el Spin o impide revalidarlo, el segundo clic se detiene. La aplicación informa el resultado y conserva la activación ya enviada; no vuelve a activarla automáticamente.

## Evidencia y rutas

Cada marca contiene juego, sesión, rol, etiqueta, coordenadas normalizadas de 0 a 1 y captura de origen. Cada captura tiene tamaño, revisión, SHA-256, imagen inmutable, pantalla padre y control que produjo la transición. Cada acción conserva la intención anterior al clic, el estado del envío, la captura siguiente y metadatos de red sin consultas, credenciales ni cuerpos de solicitudes.

**Exportar grafo** descarga JSON con todas las marcas y rutas. Los pasos incluyen `controlId`, rol, coordenadas, revisión y hash de imagen, además de la exigencia de revalidar antes de ejecutarlos. El compuesto Antebet contiene el activador seguido de su Spin vinculado.

Un clic enviado no demuestra que el proveedor haya completado una tirada o una compra. La interfaz conserva esa diferencia. Si se pierde la respuesta o se interrumpe el proceso después de guardar la intención, el envío queda desconocido y la ruta se exporta con `needs_review` y `replayAllowed: false`. Una captura nueva puede permitir seguir clasificando; no borra la incertidumbre de la acción anterior.

Este módulo captura y ejecuta los pasos indicados por la persona. El export describe **las rutas marcadas**, sus ramas y lo pendiente. La exploración autónoma exhaustiva de controles todavía no vistos, su conexión con un ejecutor de compras completo y la confirmación del protocolo de cada proveedor son trabajo posterior. El explorador BFS previo del repositorio conserva su política independiente.

## Ejecución en GitHub

El workflow **Guided classifier session** instala Node 22, Playwright/Chromium y cloudflared con versión y hash fijados. Ejecuta las pruebas antes del arranque. Abre las demos de `config/demos.json` en contextos independientes y espera inicialmente 60 segundos sin inputs en cada una. El intervalo posterior a un input es 1.500 ms.

El servidor y Chromium permanecen en el runner durante la sesión. Un túnel temporal expone la interfaz; todas las API, imágenes y operaciones requieren la clave. `config/classifier-session.json` contiene solamente el SHA-256 de esa clave. El artefacto **classifier-connection** se publica en cuanto el enlace responde, antes de mantener la sesión abierta. Contiene URL, hora de inicio y vencimiento; no contiene la clave.

Los guardados se publican en la rama independiente **classifier-data**, bajo `guided-20261023/`, mediante el token del propio workflow. Antes de enviar input debe quedar publicada su intención. Tras cada operación se publica el resultado y su imagen. Si falla esa publicación se informa el fallo. Los archivos guardados sobreviven al runner; la memoria del navegador termina con él.

La duración configurada es **180 minutos**, contados desde que el túnel responde. Para cerrar antes, cancelá la ejecución en Actions. Una nueva ejecución obtiene otra URL, restaura los datos y abre sesiones de navegador nuevas. Conserva las capturas y marcas anteriores, pero no reproduce automáticamente compras, giros ni rutas. Los juegos ya finalizados conservan su estado. No ejecutes dos escritores para el mismo identificador de sesión fuera de la exclusión del workflow.

## Reproducir en una PC

```bash
npm ci
npx playwright install --with-deps chromium
node classifier/main.mjs
```

Abrí `http://127.0.0.1:8767` e ingresá la misma clave. Sin `GITHUB_TOKEN`, los datos quedan en `artifacts/classifier-data/<runId>/`. Con `GITHUB_TOKEN` y `GITHUB_REPOSITORY` configurados, se activa la publicación a la rama de datos. `CHROMIUM_EXECUTABLE_PATH` permite usar otra instalación del navegador; `scripts/install-browser-fallback.py` instala la versión correspondiente desde Chrome for Testing si falla el CDN de Playwright.

Para verificar la interfaz sin proveedores externos:

```bash
node classifier/main.mjs --fixture --data artifacts/classifier-fixture
node --test --test-concurrency=2 classifier/test/*.test.mjs
```

Las pruebas con navegador necesitan un ejecutable instalado; `CHROMIUM_EXECUTABLE_PATH` y `CHROMIUM_PATH` pueden apuntar a él. Un Cloudflare Worker convencional no aloja este proceso de Chromium por sí solo: un port necesita mantener el navegador en un runner, contenedor o servicio de navegador compatible.

## Copia de Hybrid Cloud Fuzzer

`upstream/hybrid-cloud-fuzzer` conserva el código fuente fijado al commit `045d403e06f8255d92f1e393a755edfeed5da0c3`. El nuevo módulo importa su normalización de puntos y su comparación visual. El esquema propio agrega roles, historial y rutas que el endpoint original no conservaba. Sus archivos de despliegue copiados quedan dentro de esa carpeta; el workflow del clasificador usa sus propios archivos.

## Validación

Las pruebas de integración usan la interfaz real, el servidor autenticado, el almacén y Chromium real contra una fixture. Comprueban los seis atajos, Antebet con una referencia de Spin guardada antes de actualizar, menús anidados, vuelta, opción, cancelación, compra, confirmación, historial, exportación, restauración y ausencia de doble ejecución al repetir solicitudes. Las pruebas de fallo cubren referencias obsoletas, sesiones cruzadas, controles tapados, pérdida de captura, escritura fallida después del input, recuperación de intenciones interrumpidas y publicación de evidencia sin credenciales.

La verificación con proveedores reales acredita que cargan sus capturas y que la interfaz puede mostrarlas. Cada botón real que se enseñe sigue sujeto a su revalidación; animaciones, cambios del juego o controles de Canvas pueden requerir actualizar y marcar otra vez.

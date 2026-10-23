# Hail-Marry

Detector dinámico de controles de juegos. Prueba inicial en GitHub Actions.

## Clasificador guiado: 1–5 y Q

La interfaz de captura manual está en `classifier/`. Abre las demos en Chromium dentro de GitHub Actions, muestra las capturas y ejecuta los controles que marcás. **Q** marca y pulsa un Continue inicial; **1** guarda Spin; **2** activa Antebet y pulsa el Spin guardado; **3** abre menús; **4** ejecuta compras directas; **5** guarda Solo Spin y finaliza sin girar. Incluye roles de opción, confirmar, cancelar, volver y apuesta.

Abrir **Actions → Guided classifier session**. El artefacto **classifier-connection**, publicado al arrancar, contiene el enlace temporal; la clave se entrega por separado. La sesión dura hasta 180 minutos. Las capturas, coordenadas normalizadas, acciones y rutas se guardan en la rama `classifier-data`. [Uso, reproducción y límites](docs/guided-classifier.md).

Se incluye una copia del Hybrid Cloud Fuzzer en `upstream/hybrid-cloud-fuzzer`, fijada al commit `045d403e06f8255d92f1e393a755edfeed5da0c3`. El clasificador reutiliza su validación y comparación visual. El grafo exportado prepara las rutas enseñadas para la exploración posterior; todavía no declara cobertura automática de todos los controles de un juego.

## Estado de la prueba

La instalación en GitHub y el ciclo completo de la fixture están validados. La selección de Laya y la cobertura de las demos reales todavía no cumplen todos los requisitos; la ejecución conserva esos fallos. Ver el [informe medido del 23 de octubre de 2026](docs/github-validation-2026-10-23.md) y su [evidencia JSON](docs/github-validation-2026-10-23.json) antes de decidir el port.

## Flujo

1. Abre una DEMO pública y deja **60 segundos sin inputs** desde el inicio de navegación.
2. Lee controles DOM y árboles accesibles de motores. Tesseract extrae texto dibujado en Canvas.
3. **Laya interpreta el texto**, identifica una introducción y elige entre candidatos observados.
4. Revalida identidad, geometría y evidencia inmediatamente antes de enviar el input.
5. Espera **1.500 ms** después de cada acción y compara **dos muestras separadas por 300 ms**.
6. Guarda controles, transitorios, incertidumbres, decisiones, tiempos y capturas.

Los tres juegos se cargan en paralelo, con contextos separados. Comparten Chromium y una instancia de Laya; sólo la inferencia se serializa para no saturar la CPU.

El OCR combina lectura de texto disperso y por bloques con dos máscaras de contraste de color. Usa un hilo por proceso y conserva las coordenadas originales. Un «CONTINUE» sin más contexto sólo se propone a Laya cuando al menos dos lecturas coinciden; la decisión sigue sujeta a confianza y revalidación.

## Interpretar los resultados

Cada control tiene visible, enabled, interactable, stable, bounds, normalizedBounds, hitPoint y evidencia de origen.

| availability | Evidencia |
|---|---|
| available | Coincidencia en ambas muestras y recepción de input verificada mediante hit-test DOM |
| unavailable | Oculto, deshabilitado, fuera de pantalla o bloqueado según la evidencia disponible |
| unknown | Muestras insuficientes, geometría incierta o estado interno que no demuestra recepción de input |

La lista transient conserva controles que aparecieron, desaparecieron, se movieron o cambiaron de estado. Dos muestras reducen ruido; no demuestran persistencia continua durante todo el intervalo.

El Canvas completo nunca se trata como un botón. Los textos OCR no son automáticamente controles habilitados. Un input enviado no demuestra el resultado de una tirada; actionConfirmed permanece separado.

Adaptadores: DOM, Pixi accesible, Phaser, LayaAir y UHT/globalRuntime de Pragmatic. Los adaptadores de motor aportan candidatos y estados sin confirmar recepción de input. No se invoca el hit-test de Pixi porque modifica su ticker de eventos. **LayaAir, el motor, y Laya, el modelo de decisión, son componentes distintos.** Los árboles privados y ciertos controles sin texto quedan pendientes.

## GitHub Actions

Abrir **Actions → Dynamic controls experiment → Run workflow**. También se ejecuta al cambiar código en main.

Instala Node 22, Python 3.11, Chromium, Tesseract y Laya CPU con checkpoint fijado. Comprueba DOM/iframes/overlays/flicker, inferencia real, una fixture con espera real de 60 s y tres DEMOs: Pragmatic, Play’n GO móvil y BGaming.

El artefacto **hail-marry-evidence** contiene logs, PNG, resultados JSON y versiones Python. Se contabilizan por separado los candidatos estables visibles/habilitados y los controles con recepción de input confirmada. Si ninguna DEMO demuestra controles disponibles, la sonda termina con código 2 y conserva evidencia.

Las comprobaciones de instalación, modelo y fixture se evalúan por separado de la cobertura de las demos. La sonda requiere al menos una sesión sin errores registrados, sin una introducción reconocida pendiente y con algún control disponible. Un código 0 sólo acredita esa observación en una sesión; por sí solo no acredita controles de gameplay ni soporte completo de los tres juegos. Los candidatos de motor con estado y coordenadas estables conservan disponibilidad desconocida cuando falta evidencia de recepción de input.

## Reproducir en Linux

    npm ci
    npx playwright install --with-deps chromium
    sudo apt-get install tesseract-ocr tesseract-ocr-eng
    python -m venv .venv
    . .venv/bin/activate
    python -m pip install -r requirements-ocr.txt
    python -m pip install torch==2.8.0+cpu --index-url https://download.pytorch.org/whl/cpu
    python -m pip install -r requirements-laya.txt
    python python/laya_server.py --port 8765 --threads 2

En otra terminal:

    npm test
    npm run test:laya
    npm run test:integration
    npm run probe -- --config config/demos.json --concurrency 3

Si falla el CDN, ejecutar python scripts/install-browser-fallback.py para descargar la misma versión desde el almacenamiento oficial de Google. Pasar su ruta en CHROMIUM_EXECUTABLE_PATH.

## Integración futura

ControlStateDetector.observe(page) es de sólo lectura. GameSession.actOnControl(control) recibe el objeto observado completo, comprueba que no haya cambiado su significado, ejecuta la acción y devuelve la nueva observación. El controlador que lo utiliza decide qué acción ejecutar.

La configuración distribuida únicamente avanza introducciones explícitas. La fixture utiliza menús para comprobar el ciclo dinámico. No inicia un explorador autónomo ni reintenta indefinidamente inputs sin efecto.

Esta pila necesita un proceso con navegador y Python. Windows/GPU y otras clases de workers se evalúan después; un Cloudflare Worker aislado no ejecuta esta pila local.

Ver [diseño](docs/experiment.md) y [versiones y API de Laya](docs/laya-runtime.md).

## Exploración BFS de menús y opciones de compra FUN

Nuevo modo de búsqueda en anchura: `npm run bfs:live`. Descubre Buy Bonus, opciones de free spins, Bet +/- y Ante Bet; guarda rutas, capturas y textos nuevos en una cola GPT. Revalida cada acción, vuelve a cargar sesiones demo aisladas al recorrer ramas, nunca pulsa Spin ni confirma compras finales. El modo sin `OPENAI_API_KEY` solo guarda la clasificación pendiente; el modo con API puede solicitar clasificaciones GPT estructuradas y verificadas. [Diseño y reproducción](docs/bfs-navigation.md). La automatización está limitada a FUN/practice/demos; aún requiere validación real antes del port a un worker.

# Hail-Marry

Detector dinámico de controles de juegos. Prueba inicial en GitHub Actions.

## Flujo

1. Abre una DEMO pública y deja **60 segundos sin inputs** desde el inicio de navegación.
2. Lee controles DOM y árboles accesibles de motores. Tesseract extrae texto dibujado en Canvas.
3. **Laya interpreta el texto**, identifica una introducción y elige entre candidatos observados.
4. Revalida identidad, geometría y evidencia inmediatamente antes de enviar el input.
5. Espera **1.500 ms** después de cada acción y compara **dos muestras separadas por 300 ms**.
6. Guarda controles, transitorios, incertidumbres, decisiones, tiempos y capturas.

Los tres juegos se cargan en paralelo, con contextos separados. Comparten Chromium y una instancia de Laya; sólo la inferencia se serializa para no saturar la CPU.

## Interpretar los resultados

Cada control tiene visible, enabled, interactable, stable, bounds, normalizedBounds, hitPoint y evidencia de origen.

| availability | Evidencia |
|---|---|
| available | Coincidencia en ambas muestras y recepción de input verificada por DOM o hit-test público compatible |
| unavailable | Oculto, deshabilitado, fuera de pantalla o bloqueado según la evidencia disponible |
| unknown | Muestras insuficientes, geometría incierta o estado interno que no demuestra recepción de input |

La lista transient conserva controles que aparecieron, desaparecieron, se movieron o cambiaron de estado. Dos muestras reducen ruido; no demuestran persistencia continua durante todo el intervalo.

El Canvas completo nunca se trata como un botón. Los textos OCR no son automáticamente controles habilitados. Un input enviado no demuestra el resultado de una tirada; actionConfirmed permanece separado.

Adaptadores: DOM, Pixi accesible, Phaser, LayaAir y UHT/globalRuntime de Pragmatic. Los tres últimos pueden aportar candidatos y estados sin confirmar recepción de input. **LayaAir, el motor, y Laya, el modelo de decisión, son componentes distintos.** Los árboles privados y ciertos controles sin texto quedan pendientes.

## GitHub Actions

Abrir **Actions → Dynamic controls experiment → Run workflow**. También se ejecuta al cambiar código en main.

Instala Node 22, Python 3.11, Chromium, Tesseract y Laya CPU con checkpoint fijado. Comprueba DOM/iframes/overlays/flicker, inferencia real, una fixture con espera real de 60 s y tres DEMOs: Pragmatic, Play’n GO móvil y BGaming.

El artefacto **hail-marry-evidence** contiene logs, PNG, resultados JSON y versiones Python. Si ninguna DEMO demuestra controles de runtime disponibles, la sonda termina con código 2 y conserva evidencia.

## Reproducir en Linux

    npm ci
    npx playwright install --with-deps chromium
    sudo apt-get install tesseract-ocr tesseract-ocr-eng
    python -m venv .venv
    . .venv/bin/activate
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

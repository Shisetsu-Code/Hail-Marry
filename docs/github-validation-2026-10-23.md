# Validación en GitHub — 23 de octubre de 2026

## Resultado

**La instalación y el ciclo controlado funcionan. La validación general sigue fallando por la selección del modelo y la cobertura de las demos reales.** El experimento demuestra que la arquitectura puede ejecutarse en GitHub con CPU y descubrir controles después de una acción. Todavía no acredita un detector fiable para trasladar sin más a los juegos de un PC o worker.

- Código probado: [`e9e905a`](https://github.com/Shisetsu-Code/Hail-Marry/commit/e9e905a4259bdf2e0123e8961aeefa1675060c39).
- Ejecución final: [GitHub Actions 40024964242](https://github.com/Shisetsu-Code/Hail-Marry/actions/runs/40024964242).
- Evidencia permanente resumida: [github-validation-2026-10-23.json](github-validation-2026-10-23.json).
- Capturas, logs completos, decisiones y versiones: artefactos `hail-marry-evidence` y `laya-decision-diagnostics` de esa ejecución, conservados durante 14 días.

| Comprobación | Resultado |
|---|---|
| Instalar Node, Python, Chromium, Tesseract, Pillow y Laya CPU | Aprobada |
| Regresiones de código, navegador y contrato del modelo | 45/45 aprobadas |
| Inferencia real de Laya | 14 respuestas conservadas; 6 de 9 condiciones obligatorias satisfechas |
| Ciclo completo de la fixture con OCR y Laya reales | Aprobado |
| Cobertura de las tres demos públicas | No aprobada |
| Estado global de Actions | `failure`, conservando los fallos de inferencia y demos |

Las cinco entradas restantes del smoke son diagnósticas. El recuento de 6/9 se recalculó sobre las respuestas guardadas; el script de aserciones se detuvo en el primer incumplimiento, `session-ocr-tap`. No se considera aprobado un caso ausente o un resultado simulado.

## Qué quedó implementado

Un Chromium ejecuta tres contextos aislados en paralelo. Cada sesión espera al menos **60 segundos sin inputs** desde el inicio de navegación. El detector inspecciona DOM, frames y árboles accesibles de motores; Tesseract obtiene texto del canvas mediante cuatro lecturas y máscaras de contraste. Laya recibe texto y candidatos identificados, mientras la sesión conserva las coordenadas.

Antes del clic se comprueban de nuevo la identidad, el texto y la geometría. Los objetivos OCR se recortan, se releen y se comparan con una segunda captura. Después del input se esperan **1.500 ms** y se toman dos muestras con un intervalo solicitado de **300 ms**. Solo se acepta persistencia cuando el intervalo realmente observado queda entre 200 y 400 ms.

Los estados `available`, `unavailable` y `unknown` conservan evidencias distintas. Un árbol privado puede aportar coordenadas y flags estables sin demostrar recepción de input. El canvas completo no se convierte en un botón. La recepción de input y el resultado de una acción permanecen separados.

Los adaptadores cubren DOM y estructuras accesibles de Pixi, Phaser, LayaAir y UHT/globalRuntime. **LayaAir es un motor; Laya es el modelo de decisión de texto.** El modelo no realiza OCR. Los límites de recorridos y los árboles inaccesibles quedan registrados como cobertura incompleta.

## Prueba completa controlada

La fixture usa una introducción dibujada en canvas y controles DOM con estados visibles, deshabilitados, ocultos, cubiertos y fuera de pantalla. Incluye un menú cuyos controles aparecen con retraso y un control fugaz de 40 ms.

| Medida de la ejecución final | Valor |
|---|---:|
| Espera inicial real sin inputs | 60.001 ms |
| Inputs enviados | 3: avanzar introducción, abrir menú, cerrar menú |
| Observaciones guardadas | 8 |
| Esperas posteriores al input | 1.502 / 1.502 / 1.501 ms |
| Intervalos reales entre evidencias de controles | 293–302 ms |
| Clics en el control fugaz | 0 |
| Clics en controles cubiertos, fuera de pantalla u ocultos | 0 |
| Activaciones de Spin en la fixture | 0 |

La prueba verificó la desaparición de la introducción, la aparición de los controles del menú y su retirada al cerrarlo. El control fugaz no fue promovido a disponible. Estas comprobaciones acreditan el comportamiento de la fixture; no prueban el resultado de una acción de gameplay en un proveedor externo.

## Qué mostró Laya

Se ejecutó el paquete `laya==0.4.14`, checkpoint `convaiinnovations/laya-multilingual`, revisión `1720e3e3357cfe1e281542e223f8273b0890ca34`, con PyTorch `2.8.0+cpu` y dos hilos. Los pesos se verifican mediante SHA-256. Las dos preguntas y la respuesta raw se conservan; el umbral sigue siendo **0,80 sobre la menor confianza de intención y destino**. Las versiones y el contrato están en [laya-runtime.md](laya-runtime.md).

| Caso obligatorio | Resultado final | Confianza conservada |
|---|---|---:|
| Introducción con contexto «Welcome to the game» | Continúa con el candidato correcto | 0,8136 |
| Pantalla de gameplay con SPIN/BUY BONUS | Sin acción | 0,6295 |
| Payload exacto `CLICK TO CONTINUE` | Continúa con el candidato correcto | 0,8749 |
| `TAP TO CONTINUE` | Se abstiene; incumple el positivo esperado | 0,6507 |
| CONTINUE entre SPIN y BUY BONUS | Laya elige SPIN; el servicio rechaza el destino | 0,9579 |
| Los mismos candidatos reordenados | Se abstiene; incumple el positivo esperado | 0,7052 |
| `SPIN` aislado | Sin acción | 0,5381 |
| `BUY BONUS` aislado | Sin acción | 0,4802 |
| `BUY BONUS TO CONTINUE` | Sin acción | 0,6082 |

En los cinco diagnósticos adicionales, `Click to continue` y `CLICK ANYWHERE TO START` fueron accionables; `Welcome. CLICK TO CONTINUE`, `CONTINUE` y `| CONTINUE` produjeron abstenciones. La redacción y el orden de los candidatos afectan al resultado. La confianza del modelo no es una probabilidad de acierto calibrada para estos juegos.

Los casos mezclados ejercitan directamente la API del modelo. No reproducen el payload habitual de `GameSession`, que filtra SPIN/BUY antes de proponer candidatos de introducción. Permiten comprobar qué ocurriría si otro consumidor del servicio enviara una lista más amplia.

El error de selección se observó con inferencia real: en el caso mixto el modelo eligió SPIN con confianza de destino **0,9938**. Se añadió un rechazo explícito de etiquetas de gameplay/compra como el que ya usa el scanner. El servicio devuelve `needs_review`, `action: none`, `reason: blocked_target_label`, conservando la respuesta raw, la confianza y `inference: true`. **No elige otro candidato por su cuenta ni presenta una regla como inferencia de Laya.** El error semántico sigue contabilizado como fallo. La lista de exclusiones es acotada y no acredita cobertura de todos los idiomas o etiquetas.

Las 14 inferencias aisladas tardaron **385–541 ms** en este runner CPU. Esa medida excluye descarga, arranque, captura, OCR, espera en cola y navegación; no equivale al tiempo total de una observación.

## Demos públicas

Las tres sesiones se ejecutaron en paralelo y tardaron **92.994 ms** en conjunto, incluyendo la espera inicial. La configuración distribuida solo permite avanzar introducciones explícitas; no contiene una secuencia de tiradas.

| Demo | Registros observados | Estables, visibles y habilitados | Disponibilidad de input confirmada | Inputs enviados | Resultado |
|---|---:|---:|---:|---:|---|
| Pragmatic — 3 Dancing Monkeys | 225 | 24 | 0 | 0 | `needs_review` |
| Play’n GO — Amulet of Dead, móvil | 2 | 0 | 0 | 0 | `intro_pending` |
| BGaming — Three Lucky Monkeys | 0 | 0 | 0 | 0 | Rechazo antes del input |

**Pragmatic.** Los registros estables visibles/habilitados corresponden a **9 rutas UHT distintas**, no a 24 botones únicos. Se recuperaron coordenadas de Spin y del menú mediante la proyección de colliders y cámaras. La disponibilidad continúa en `unknown`: flags y geometría no prueban que el motor reciba el input. Dos límites de resultados UHT por muestra mantienen el inventario parcial. En la ejecución final se inspeccionaron 19 cámaras y un canvas.

**Play’n GO.** El OCR reconoció `CONTINUE` con lecturas coincidentes. Laya realizó inferencia, pero su confianza final fue **0,7636**, por debajo de 0,80. La introducción quedó pendiente y no se envió input.

**BGaming.** Laya aprobó `CLICK ANYWHERE TO START` con confianza **0,8224**. La relectura del recorte también reconoció exactamente el texto, con confianza OCR **95,74** y tres lecturas coincidentes. Sin embargo, la comparación de las dos capturas encontró **3.186 píxeles RGB distintos de 12.180**, dentro de la región del texto. Se registraron `textMatched: true` y `unchangedPixels: false`; el sistema rechazó el clic. La comparación exacta del recorte es una limitación práctica: esta prueba no acredita el avance de una introducción cuyo aspecto varía aunque se siga leyendo el mismo texto.

Los artefactos conservan las capturas y los motivos de rechazo. Una introducción visible pendiente o cero controles disponibles impiden que la sesión se considere validada. Dos muestras aportan persistencia observada, sin garantizar continuidad entre ellas.

### Coste observado con tres juegos concurrentes

| Observación | Captura, detector y OCR en conjunto | Solo OCR |
|---|---:|---:|
| Fixture, ocho observaciones | 1.509–1.587 ms | 1.157–1.233 ms |
| Pragmatic, inicial | 12.395 ms | 6.066 ms |
| Play’n GO, inicial | 8.893 ms | 2.598 ms |
| BGaming, inicial | 11.007 ms | 4.690 ms |
| BGaming, revalidación | 7.445 ms | 2.841 ms |

Las dos inferencias en las demos tardaron 1.790 ms y 1.490 ms, frente a 385–541 ms en la comprobación aislada. El intervalo de muestreo de aproximadamente 300 ms y la pausa posterior de 1.500 ms son componentes del ciclo; **la observación completa tarda más** por captura, OCR y carga concurrente. Estas mediciones pertenecen a este runner y estas pantallas.

## Correcciones comprobadas durante el experimento

- Se corrigió el workflow para que un error dentro de una tubería con `tee` produzca fallo real. La [primera ejecución verde](https://github.com/Shisetsu-Code/Hail-Marry/actions/runs/40017570992) se descartó como evidencia porque ocultaba fallos.
- El OCR pasó a usar un hilo por proceso y lecturas complementarias; los juegos aportan el paralelismo. Esto permitió leer la introducción de la fixture.
- Las geometrías nulas estables dejaron de aparecer como falsos cambios transitorios. La búsqueda de cámaras UHT se amplió para incluir la cámara de UI observada en Pragmatic.
- Se aclaró la pregunta de destino de Laya: el payload exacto `CLICK TO CONTINUE` pasó de confianza de destino 0,6847 a 0,9455. Los casos adicionales revelaron los límites semánticos descritos arriba.
- Se cubrió `/etc/apt/apt-mirrors.txt` al cambiar el servidor Ubuntu del runner. El log de la [ejecución 40023847118](https://github.com/Shisetsu-Code/Hail-Marry/actions/runs/40023847118) confirma el uso efectivo de `archive.ubuntu.com`; cambiar solo `sources.list` no había cubierto esa lista.
- Se añadieron el rechazo del destino incorrecto y evidencias separadas de OCR/píxeles antes del input. Las aserciones semánticas permanecieron exigentes.

## Decisión sobre el port

Está acreditada la ejecución de esta pila en **Ubuntu 24.04, Node 22 y Python 3.11**, con un navegador y una instancia local de Laya CPU compartida. El [README](../README.md) contiene los comandos para reproducirla y lanzar Actions manualmente.

**La validación de uso general queda pendiente.** Antes de dar por aprobado el port a los juegos reales faltan tres resultados concretos: selección correcta o abstención fiable ante candidatos mezclados, resolución de introducciones animadas conservando evidencia actual y comprobación de disponibilidad de input en los motores privados. Trasladar el mismo código a otra máquina no resuelve por sí solo esos fallos.

El entorno de destino debe poder ejecutar Chromium y Python. Windows, GPU y otras clases de worker no se probaron. La inferencia se comparte entre páginas y solo esa fase se serializa; cargar una copia del modelo por página no forma parte del diseño probado.

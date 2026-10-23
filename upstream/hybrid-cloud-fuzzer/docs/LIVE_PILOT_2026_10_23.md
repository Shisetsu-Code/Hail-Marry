# Prueba real de compras DEMO — 23 de octubre de 2026

Se verificaron dos recorridos de compra de bonus hasta el final, en GitHub Actions:

| Juego | Compra ficticia | Premio mostrado al cerrar | Estado |
| --- | --- | --- | --- |
| 3 Dancing Monkeys | Free Spins, $180 | $94,68 | Completado y cobrado; pantalla base |
| 3 Buzzing Wilds | Free Spins, $200; opción Random Wilds | $61,00 | Completado y cobrado; pantalla base |

Ambas capturas finales muestran `FREE SPINS COMPLETED`. Los registros privados
confirman `roundOutcome=completed`, `terminal=true`, resultado observado, regreso
a `stable-idle` y evidencia de apuesta. El recorder cubre todo el recorrido,
incluyendo `doCollect` (una vez por recorrido). Los `doSpin` de la traza incluyen
las tiradas del bonus: no se cuentan como pruebas de tiradas normales adicionales.

- Dancing Monkeys: [ejecución](https://github.com/Shisetsu-Code/Hybrid-actions/actions/runs/39964713236), tanda `live-finish-20261023`; captura final `step-84e654b5d8700cf3abcc`.
- Buzzing Wilds: [ejecución final, intento 2](https://github.com/Shisetsu-Code/Hybrid-actions/actions/runs/39969262273/attempts/2), tanda `live-complete-20261023`; captura final `step-7e6e28eb07e21d8ce3c2`.

Las capturas y trazas permanecen en R2 privado, accesibles con las credenciales
existentes. Se conservaron también las capturas y registros de intentos parciales;
no se convirtieron en éxitos. Una ejecución cancelada después de empezar una
acción se conserva como incierta y no se reintenta automáticamente.

## Fallos corregidos al probar

- Confirmaciones reales de compra con nombres internos distintos.
- `StopSpin_Button` etiquetado como `ananas`, que antes parecía una pantalla base.
- Elecciones Wilds, inicio de free spins y premio final como fases distintas.
- Botones `ButtonContinue` cuyo texto visible era un número o felicitación.
- Evidencia de resultado y apuesta conservada entre todos los pasos del recorrido.
- JPEG de respaldo conservado incluso con controles estructurados.
- Instalación del reloj de animación antes de arrancar el juego.
- Espera de proveedor superpuesta con otro juego; capacidad temporal configurable.
- Instalación repetida de navegador eliminada del workflow: usa Chrome del runner.

## Alcance y tiempos

Esto verifica una compra de bonus por juego, no todo el árbol de opciones de
cada título ni el catálogo de proveedores. En Buzzing Wilds se comprobó Random
Wilds; no se declaran probadas las otras dos variantes. Tampoco se declaran
realizadas dos tiradas normales adicionales por juego.

La suma de esperas de transición del recorrido final fue de 147,4 s en Dancing
Monkeys y 158,4 s en Buzzing Wilds; esos números excluyen preparación y carga.
El factor 4x del reloj de interfaz no garantiza multiplicar por cuatro el
rendimiento total ni acelera respuestas del servidor. La primera tanda tuvo
esperas y correcciones adicionales; estos tiempos no representan toda la sesión.

La prueba no demuestra todavía el rendimiento de una tanda grande ni de todos
los juegos en paralelo. El workflow nuevo admite 1–8 slots y respeta los límites
del proveedor. Las dos compras finales aquí documentadas se cerraron en
recorridos separados; no se presentan como benchmark de ejecución simultánea.

## Verificación de código

`npm run check`; 170 pruebas unitarias pasadas (otras 5 requieren navegador),
y las 5 pruebas de integración con Chromium pasadas. Hay regresiones específicas
para los paths, etiquetas y fases observados en estos juegos.

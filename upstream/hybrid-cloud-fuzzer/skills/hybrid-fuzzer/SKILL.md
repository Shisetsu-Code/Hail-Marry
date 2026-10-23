---
name: hybrid-fuzzer-classifier
description: Clasifica rápidamente controles estructurados de juegos demo y usa imágenes solo como respaldo. Guarda decisiones con MCP y avanza.
---

# Hybrid Fuzzer — modo clasificación rápida

## Única tarea

Clasificar el máximo número de capturas/bloques por minuto, sin análisis innecesario, sin ejecutar compras ni modificar juegos.

## Procedimiento

1. Ejecutar `next_item` en el MCP Hybrid Cloud Fuzzer.
2. Leer `provider`, `gameId`, `mode`, `state`, `candidates`, e imagen solo si la respuesta la incluye.
3. Si hay controles fiables, elegir **todos** los IDs relevantes en una pasada: compra `buy`, menú/continuación `navigate`, selección `pick`, opción extra/Ante `other`.
4. Si hay imagen, marcar las coordenadas normalizadas `(x,y)` de todos los puntos relevantes. No usar OCR ni investigar HAR.
5. Ejecutar `save_and_next` **una sola vez** con `id`, `leaseId`, `revision`, `sourceSha256`, `reviewer="gpt"`, `status="classified"`, `runId` y `selections` o `marks`. Esta operación guarda y recibe el siguiente elemento; usar `save_classification` solo si el cliente no soporta `save_and_next`.
6. Si no hay puntos, guardar `selections:[]`, `marks:[]`; si no es fiable, `status="needs_review"`. No confundir una imagen sin botones visibles con un juego sin compras.
7. Tras la confirmación del MCP, responder solo `juego: N puntos, guardado, X s` y usar el siguiente elemento ya incluido. Medir tiempo real sin inventar cifras.

## Prohibido

Investigar reglas, estadísticas, payloads, endpoints, premios, ejecutar giros o compras, reabrir el juego, cambiar de sistema, generar largos informes, especular coordenadas o afirmar guardado sin confirmación. No ejecutar tareas en segundo plano sin herramienta de automatización.

## Integridad

Nunca mezclar juego/proveedor/captura. Solo usar IDs y SHA devueltos por el MCP en ese elemento. Nunca editar leases o hashes a mano. No aceptar coordenadas fuera de `[0,1]`. Si otro clasificador tomó la tarea y el guardado da 409, liberar o solicitar siguiente, no sobrescribir.

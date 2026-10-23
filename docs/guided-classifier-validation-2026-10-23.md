# Validación del clasificador guiado — 23 de octubre de 2026

Primera versión publicada: [`6399a0b`](https://github.com/Shisetsu-Code/Hail-Marry/commit/6399a0b3ad3f93190adcbd8c7afa32bf1488e45f). Primera ejecución: [Guided classifier session 40039101204](https://github.com/Shisetsu-Code/Hail-Marry/actions/runs/40039101204).

## Evidencia comprobada

- **114 pruebas locales aprobadas**, sin fallos ni omisiones, contra el árbol exacto publicado. Incluyen 55 pruebas existentes y 59 del clasificador.
- El paso completo de pruebas también terminó correctamente en GitHub, con Node 22 y Chromium instalado en el runner.
- Integración con interfaz real, servidor autenticado, almacén y Chromium: **14 inputs de fixture y 15 rutas**. Se verificaron Q, 1–5, Antebet con Spin guardado antes de actualizar, menús anidados, opciones, vuelta, cancelación, compra y confirmación.
- El proceso CLI real inició dos juegos de fixture, sirvió imágenes cuyos SHA-256 coincidían, rechazó accesos sin clave y terminó por SIGTERM con sus 13 procesos de navegador/servidor cerrados.
- Revisión independiente completada. Se corrigieron incertidumbre de envío, fallos de escritura después de un clic, recuperación de la ascendencia de rutas, controles de capturas finalizadas y la elegibilidad de una compra incierta tras reiniciar.
- El intento de crear un árbol vacío mediante GitHub devolvió HTTP 422. La inicialización se corrigió para crear un README en un commit sin padres y se probó esa restricción. La publicación real creó posteriormente `classifier-data`.

## Primera sesión iniciada

El servidor y el túnel temporal arrancaron en GitHub. El propio runner comprobó HTTP satisfactorio en la URL pública antes de publicar el artefacto **classifier-connection**. La sesión empezó a las **23:21:41 UTC** y tiene vencimiento a las **02:21:41 UTC del 24 de octubre**. El workflow permanece en ejecución para mantenerla disponible; su paso de espera no representa un fallo.

La clave de acceso se entrega por separado. El repositorio y los artefactos públicos sólo contienen su hash o metadatos de conexión.

## Capturas reales guardadas

Las tres imágenes fueron descargadas desde la rama de datos y verificadas contra el SHA-256 registrado. No se enviaron inputs a esas demos durante esta comprobación.

| Juego | Resultado visual de la captura inicial | Tamaño |
| --- | --- | --- |
| Pragmatic — 3 Dancing Monkeys | Pantalla de juego, Spin y Buy Free Spins visibles. | 1280 × 720 |
| BGaming — Three Lucky Monkeys Hold & Win | Introducción con «Click anywhere to start», utilizable para enseñar Q. | 1280 × 720 |
| Play’n GO — Amulet of Dead móvil | Pantalla mayormente negra con logotipo y sonido. No se acreditó que el juego estuviera listo para clasificar. | 412 × 839 |

Estado y evidencia: [classifier-data/guided-20261023](https://github.com/Shisetsu-Code/Hail-Marry/tree/classifier-data/guided-20261023).

## Límites de esta validación

El acceso directo al túnel desde el entorno de desarrollo devolvió **HTTP 403** antes de llegar a las API; la ruta directa sin proxy falló por DNS. Por eso no se afirma que se haya completado una comprobación autenticada del enlace público desde ese entorno. La interfaz autenticada sí quedó probada íntegramente contra el servidor local real y el túnel respondió al comprobador ejecutado en GitHub.

La revisión de capturas acredita dos pantallas útiles y una pantalla móvil pendiente. No acredita que todas las opciones de todos los proveedores hayan sido exploradas. El exportado conserva las rutas enseñadas y sus incertidumbres; un barrido autónomo exhaustivo posterior sigue fuera de esta entrega.

## Corrección de coordenadas móviles y nueva verificación

La captura móvil permitió detectar una diferencia real entre las coordenadas de la imagen y las del viewport de la página. Se reprodujo con Chromium emulando Pixel 7 en una página sin meta viewport: el punto visible de Continue debía transformarse antes de enviar el clic. El runner ahora guarda escala, desplazamientos y dimensiones, transforma las marcas y candidatos en el sentido correspondiente y rechaza cambios de viewport antes de enviar input.

La verificación final local de esta corrección aprobó **120 pruebas, cero fallos, cero omisiones**, en 37,71 segundos. Incluye 55 pruebas existentes y 65 del clasificador. Las regresiones cubren el input real en Continue móvil, transformaciones inválidas, cambios de zoom durante la validación y capturas con el mismo JPEG pero distinta transformación. La revisión independiente no encontró bloqueos.

La sustitución de la primera sesión se solicitó de forma explícita mediante `[restart-classifier]`. La sesión inicial no contenía marcas ni acciones del usuario. El reinicio conserva su evidencia y crea sesiones nuevas de navegador; no reproduce inputs.

## Sesión corregida iniciada

La corrección quedó publicada en [`d6dfd8b`](https://github.com/Shisetsu-Code/Hail-Marry/commit/d6dfd8b9884ab94701f50065353c5d0821e189f6). El árbol remoto `17c2bc87a4de418627f6a5f768d3780ec229a282` coincide exactamente con el árbol local verificado. La [ejecución 40040777781](https://github.com/Shisetsu-Code/Hail-Marry/actions/runs/40040777781) completó correctamente instalación, pruebas, inicio del servidor/túnel y publicación de la conexión. La ejecución anterior terminó cancelada por el reemplazo explícito.

La nueva sesión empezó el **23 de octubre a las 23:41:03 UTC** y vence el **24 de octubre a las 02:41:03 UTC**. Su artefacto `classifier-connection` registra estos datos. El paso de espera permanece activo para servir la interfaz.

La comprobación externa de sólo lectura desde el entorno de desarrollo volvió a obtener HTTP 403 en `/health`, antes de enviar una clave o consultar las API. Se mantiene por tanto la limitación de verificación externa descrita arriba; no se afirma que el navegador de este entorno haya abierto la interfaz pública.

El estado de datos [`d0bf11b`](https://github.com/Shisetsu-Code/Hail-Marry/tree/d0bf11b3c45fb5b784cf12d5e49e607222977f15/guided-20261023) confirma tres sesiones nuevas, captura actual de revisión 2 en cada juego y conservación de las imágenes anteriores. Las tres imágenes nuevas se descargaron, verificaron contra sus SHA-256 e inspeccionaron visualmente. En ese momento había cero marcas y cero acciones en los tres juegos.

| Juego | Estado visual tras el reinicio |
| --- | --- |
| Pragmatic — 3 Dancing Monkeys | Listo para clasificar: rodillos, Spin y Buy Free Spins visibles. |
| BGaming — Three Lucky Monkeys Hold & Win | Listo para enseñar Q: introducción con «Click anywhere to start». |
| Play’n GO — Amulet of Dead móvil | Sigue pendiente: pantalla azul de carga con logo y barra casi vacía; todavía no aparecen controles de juego. |

La actualización de estas notas sólo modifica documentación y no sustituye la sesión que se entrega.

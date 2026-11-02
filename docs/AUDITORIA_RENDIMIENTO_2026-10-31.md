# Auditoría de esperas, carga y rendimiento — 31 de octubre de 2026

Estado posterior: las correcciones se aplicaron el 1 de noviembre. Ver [cambios y verificación](MEJORAS_RENDIMIENTO_2026-11-01.md). El contenido siguiente conserva los hallazgos y resultados originales de la auditoría.

## Alcance y resultado

Revisión del móvil Expo/React Native y de los caminos del backend que usa: guardado, catálogo, sincronización, jornadas, historial, respaldos y reportes. La aplicación sigue pensada para dos personas que comparten un negocio. No se modificó código de la aplicación ni se consultaron datos de producción.

Se encontraron esperas de interfaz y dependencias de red evitables. No se encontraron peticiones HTTP síncronas en el código revisado: el cliente común usa `fetch`; el transporte instalado de React Native abre XMLHttpRequest en modo asíncrono. Un `await` puede retrasar la confirmación de una acción o bloquear una cola lógica sin congelar por sí mismo el hilo de JavaScript.

No hay mediciones de un teléfono físico ni de la latencia real de Render/PostgreSQL. Los hallazgos distinguen comportamiento reproducido con I/O simulado, comportamiento observado en código y riesgo que crece con los datos. No se atribuye lentitud a una dependencia o proveedor sin medirlo.

## Cambios prioritarios

### 1. Categorías: la confirmación local espera a toda la sincronización — P2

**Evidencia:** `mobile/src/components/CategoryManagerModal.tsx:55`, `:81` y `:115` esperan `pushSync()` después de confirmar la escritura local. La selección, el cierre del modal o el refresco ocurren después. El botón de cerrar también se deshabilita mientras se envía.

**Reproducción:** ejecutando el cuerpo real de `handleCreate` con una promesa de envío detenida, la categoría ya estaba guardada localmente, pero todavía no se seleccionaba ni se cerraba el modal. Ambas acciones llegaron únicamente al resolver el envío.

**Impacto:** una categoría usada para completar una venta queda atada a la red y a otros pendientes, a diferencia de clientes y productos, que ya envían en segundo plano.

**Corrección:** confirmar la escritura SQLite, actualizar selección/lista y liberar la interfaz; iniciar el envío en segundo plano como en los otros formularios. Conservar el tratamiento de conflictos en pendientes y no presentar la escritura como exitosa antes de que SQLite confirme.

### 2. Enviar clientes/productos depende de consultar una jornada — P2

**Evidencia:** `mobile/src/services/sync.ts:879` espera `resolveTodayWorkDay()` antes de `pushOutbox()`. La resolución consulta `/workdays/current` (`:313`). El cliente HTTP tiene un límite predeterminado de 60 segundos.

**Reproducción:** con la respuesta de jornada detenida, la cola no se inspeccionó. Al liberar esa respuesta comenzó la inspección. Incluso una cola vacía produjo la petición de jornada.

**Impacto:** una consulta ajena a una edición de cliente, categoría o producto retrasa su envío y mantiene ocupada la sincronización global.

**Corrección:** inspeccionar primero los pendientes, salir si no hay trabajo y resolver la jornada sólo cuando existan preventas que lo necesiten. Permitir enviar entidades independientes aunque falle esa consulta. Mantener las comprobaciones del servidor para preventas y jornadas cerradas.

### 3. Un fallo del pull impide intentar el push completo — P2

**Evidencia:** `mobile/src/services/sync.ts:1010` hace `pullCatalog()` antes de `pushOutbox()`, bajo el mismo `try/catch` exterior.

**Reproducción:** al simular un fallo exclusivamente en `/sync/pull`, el resultado fue `ok: false` y la cola de salida no se leyó. Esto también puede demorar un `pushSync` solicitado durante la ejecución completa, porque espera el trabajo activo.

**Impacto:** los datos locales se conservan, pero la indisponibilidad de la consulta del catálogo retrasa envíos que podrían funcionar por sus rutas propias.

**Corrección:** representar por separado el resultado del envío y de la descarga. Intentar trabajo de salida independiente si sólo falla la descarga, conservando las validaciones de negocio, el orden de dependencias, los ACK de snapshots y la idempotencia. No intercambiar indiscriminadamente todas las operaciones ni declarar éxito completo cuando sólo una fase terminó.

### 4. Recargas del catálogo vacían listas ya visibles — P2

**Evidencia:** `mobile/src/hooks/useSaleCatalog.ts:43` y `:57` vacían clientes y productos antes de leer SQLite. Se ejecutan también al cambiar `catalogRevision`. En `mobile/src/context/SyncContext.tsx:75` la revisión aumenta por un sync completo exitoso, sin una señal que pruebe que cambió el catálogo; el servicio además puede haber omitido el pull por su intervalo mínimo.

**Reproducción:** con el mismo filtro y sólo una revisión nueva, una lista con un producto y un cliente pasó a cero filas mientras sus lecturas estaban pendientes.

**Impacto:** parpadeo, desaparición temporal de resultados y posible desplazamiento alterado en mitad de una venta.

**Corrección:** conservar las filas de la misma consulta mientras se refrescan y reemplazarlas al recibir la respuesta vigente. Mantener las protecciones contra respuestas de filtros o clientes anteriores. Emitir la revisión por cambios realmente aplicados al catálogo, incluyendo categorías, presentaciones, combos y bajas; no sólo por concluir una sincronización.

### 5. El editor de producto carga todo el catálogo antes del producto elegido — P2

**Evidencia:** `mobile/src/screens/ProductFormScreen.tsx:75` espera `listProducts()` completo antes de `getProduct(productId)`. Esto también sucede al editar un producto normal. `listProducts` hidrata presentaciones, favoritos y definiciones/opciones de combos. Mientras `loading` sigue activo el formulario devuelve `null` (`:385`). El efecto de carga tampoco tiene manejo de rechazo y liberación en `finally`.

**Impacto:** trabajo innecesario en la apertura; si esa lectura falla, puede quedar una pantalla vacía en lugar de un error recuperable. El coste en milisegundos del teléfono no se midió.

**Corrección:** cargar primero el producto necesario, mostrar un estado de carga visible y un error con reintento. Obtener candidatos para opciones sólo cuando se utilice la edición de combos, con datos mínimos o carga por partes. No paralelizar consultas dependientes de identificadores todavía desconocidos.

## Mejoras siguientes

### 6. Historial vuelve a depender de la red para reconstruir el detalle abierto — P2

**Evidencia:** `mobile/src/screens/HistoryScreen.tsx:63` borra `ordersMap`; luego espera `/workdays/history` (`:71`) antes de llamar a `loadOrders` para la jornada que estaba expandida (`:87`). `loadOrders` sí dispone de una copia SQLite que puede mostrar antes de la red. El historial también se refresca con `syncTick`, incluso después de un envío sin cambios históricos.

**Impacto:** un detalle que ya era visible desaparece y puede esperar una petición con el límite predeterminado de 60 segundos para recuperar su copia local.

**Corrección:** conservar los detalles vigentes por jornada, mostrar inmediatamente el detalle local abierto y actualizar la lista remota en segundo plano. Invalidar sólo jornadas afectadas y respetar la identidad del usuario/consulta y los controles de respuestas antiguas.

### 7. “Recientes” hidrata dos veces los mismos productos — P3

**Evidencia:** `mobile/src/hooks/useSaleCatalog.ts:61` consulta los productos recientes para el filtro; otro efecto en `:88` repite la misma función sólo para conocer su longitud. La función del repositorio hidrata productos, no devuelve únicamente un contador.

**Reproducción:** al montar el hook con un cliente seleccionado y filtro `recent`, se realizaron dos llamadas a `listRecentProductsForClient`.

**Corrección:** reutilizar el resultado por cliente/revisión o consultar únicamente IDs/conteo para el atajo. Mantener la invalidación al cambiar de cliente. No hace falta incorporar otra biblioteca de estado para resolverlo.

### 8. Refresco habitual y recuperación completa usan el mismo camino — P3

**Evidencia:** `mobile/src/context/SyncContext.tsx:141` ejecuta la variante forzada; ésta consulta `/workdays/current?fresh=1`, vuelve a resolver `/workdays/current` y fuerza el catálogo desde 1970 en `mobile/src/services/sync.ts`. También hay sincronizaciones completas en acciones que ya enviaron o confirmaron su cambio. El cierre de jornada hace una antes de cerrar y otra después.

**Impacto:** más peticiones, filas transferidas e integración SQLite de las necesarias para un refresco normal. No todas las esperas son eliminables: el cierre necesita confirmar que no queden preventas pendientes.

**Corrección:** separar refresco incremental, envío de pendientes, consulta fresca de jornada y recuperación completa. Conservar una acción explícita de recuperación; no eliminar sus garantías para acelerar el refresco común.

### 9. Inicio y algunos listados secundarios crean todos sus elementos — P3, depende del volumen

**Evidencia:** `mobile/src/screens/DashboardScreen.tsx:730` dibuja todas las preventas con `recentOrders.map` dentro de `ScrollView`, sin límite de recientes. El consolidado de productos de `DailySalesScreen` y el detalle expandido del historial también usan listas completas dentro de contenedores no virtualizados. El inicio se vuelve a cargar tras `syncTick`.

**Impacto:** coste de renderizado y memoria que aumenta con una jornada grande. No se comprobó una caída de cuadros en los teléfonos de los usuarios. Los listados principales de productos y clientes ya usan `FlatList`.

**Corrección:** limitar el inicio a preventas recientes con acceso al listado completo; usar `FlatList` o `SectionList` donde el volumen lo justifique. No crear una compleja paginación en pantallas pequeñas sin medir antes.

### 10. Dos reportes de una jornada se serializan hasta terminar la descarga — P3

**Evidencia:** `backend/src/routes/reports.ts:114` mantiene `withReportDirectoryLock(reportDir)` durante generación y `res.download` (`:124`). El lock de `backend/src/services/report-storage.ts:9` es exclusivo por carpeta, aunque un usuario pida PDF y otro Excel. La generación vuelve a ejecutarse en cada solicitud, incluso con un archivo ya existente; el deduplicador de generación está dentro de esa exclusión.

**Reproducción:** usando el lock real y operaciones simuladas, la segunda operación de la carpeta no comenzó hasta terminar la primera.

**Corrección:** si esto aparece en el uso real, permitir descargas concurrentes mediante reservas de lectura y exclusión con limpieza, y deduplicar generación por archivo/versión de jornada. Mantener archivos temporales, publicación atómica y protección frente a GC; quitar simplemente el lock reintroduciría problemas de integridad.

## Costes conocidos que no deben confundirse con fallos

- **Guardar una preventa comprueba el catálogo antes de escribir.** `NewSaleScreen.tsx:406` espera una validación de hasta 8 segundos configurados en `saleValidation.ts:163`. Esto protege frente a clientes/productos eliminados y permite revisar precios. Conviene mostrar claramente “Verificando catálogo”, estudiar una comprobación previa ligada a la versión exacta del carrito y mantener la decisión explícita de guardar sin verificar. No suprimir el control ni confirmar éxito antes de guardar localmente.
- **Los envíos de outbox son secuenciales.** Conservan dependencias y simplifican ACK. Las latencias de distintas peticiones se acumulan. Antes de introducir concurrencia, medir tamaño/tiempo de cola y considerar un presupuesto de trabajo y lotes por dependencias. No sustituir el bucle por un `Promise.all` sin límites.
- **El núcleo de precios, SQLite y los formularios de clientes/productos no dependen del éxito de red para confirmar su escritura local.** Ese patrón debe conservarse.
- **Los respaldos simples ya liberan la transacción antes del I/O del archivo.** La variante que además reinicia/restaura conserva el lock para evitar perder escrituras entre copia y reemplazo. No quitar ese lock a ciegas.
- **JSON y generación de documentos tienen tramos de CPU síncronos.** `JSON.stringify`/`JSON.parse` de respaldos completos y la construcción de PDF/Excel crecen con los datos. El PDF ya escribe a un stream; no se concluye que cargue todo el archivo en RAM. Hace falta medir los datos reales antes de proponer workers o cambiar bibliotecas.
- **El timeout HTTP necesita una clasificación por transporte.** El temporizador de `apiFetch` se limpia antes de `res.json()`. Una prueba con un fetch simulado que entrega cabeceras antes del cuerpo deja esa lectura sin límite global. Sin embargo, React Native 0.74 usa el `whatwg-fetch` instalado, que resuelve en `xhr.onload`; la descarga lenta sí fue abortada al probar ese transporte con XHR simulado. Por tanto, NO se clasifica como un fallo de timeout de red demostrado en Android. Puede reforzarse el límite total para otros transportes/lecturas, con pruebas específicas.
- No se midió una dependencia externa lenta, un arranque en frío del servidor ni una consulta PostgreSQL lenta. No se recomienda reemplazar Expo, SQLite, PostgreSQL o el hosting basándose sólo en este examen.

## Verificación ejecutada

- Node.js 24.22.1.
- Móvil `tsc --noEmit`: exit 0.
- Jest completo: **21 suites, 334 pruebas; 332 aprobadas, 2 fallidas y 0 omitidas**.
- Las dos fallidas están en `mobile/src/__tests__/outbox_details.test.ts:38` y `:47`: esperan el resumen anterior sin el nuevo campo `conflict: 0`. Deben actualizarse manteniendo las comprobaciones de cantidades y ampliando los casos reales de conflictos. No demuestran una regresión de rendimiento.
- El backend había pasado **229/229** en la verificación inmediatamente anterior de este chat; no se repitió porque esta auditoría no cambió el backend.
- Ocho comprobaciones controladas sobre código real con dependencias de I/O simuladas. Una de ellas se contrastó con el transporte instalado para descartar una extrapolación incorrecta al móvil.
- Resultados estructurados: `mobile/.expo/performance-audit-2026-10-31.json` y `mobile/.expo/audit-mobile-tests-2026-10-31.json`. Son archivos locales ignorados, no pruebas de latencia física ni una suite nueva del proyecto.

## Orden recomendado para este negocio

Primero: categorías sin esperar red, preconsulta de jornada sólo cuando corresponda, tratamiento independiente de fallos de pull/push, conservación de listas al refrescar y apertura ligera del editor de producto. Después: historial, lectura duplicada de recientes y separar refresco de recuperación. Medir listas largas y reportes simultáneos antes de acometer optimizaciones mayores.

Para medir en los teléfonos: repetir las mismas acciones y revisar Mi cuenta → Mediciones de rendimiento. Separar `sale.catalog_validation` de `sale.local_save`, `sync.queue_wait` de `sync.outbox` y `db.transaction_wait` de `db.transaction`. Estas mediciones no identifican por sí solas una consulta o un proveedor lento. Contrastar el rendimiento final con un APK en modo de publicación, porque el modo de desarrollo añade trabajo.

## Referencias

- [React Native: ScrollView frente a FlatList](https://reactnative.dev/docs/scrollview): creación de todas las filas frente a renderizado gradual.
- [React Native: rendimiento](https://reactnative.dev/docs/performance): hilo de JavaScript y diferencias del modo de desarrollo.
- Transporte revisado localmente: `mobile/node_modules/react-native/Libraries/Network/fetch.js`, `Libraries/Core/setUpXHR.js` y `mobile/node_modules/whatwg-fetch/dist/fetch.umd.js` (3.6.20).

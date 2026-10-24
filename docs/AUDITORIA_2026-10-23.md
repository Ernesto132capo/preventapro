# Auditoría de PreventaPro 1.0.2 — 23 de octubre de 2026

> Informe histórico del código auditado. Las correcciones implementadas posteriormente y su validación están en [CORRECCIONES_2026-10-24.md](CORRECCIONES_2026-10-24.md).

Código revisado: commit `517633c161691133d1a76033468e4662bcbf725d`.

Se revisaron backend y móvil: sincronización, SQLite, outbox, jornadas, catálogo, combos, formularios, autenticación offline, respaldos y reportes. Se ejecutaron las suites existentes y reproducciones locales con funciones de producción, SQLite en memoria y respuestas HTTP controladas. No se modificó lógica de producción, no se consultó ni alteró la base de producción y no se publicó una versión nueva.

Los casos de pérdida de ediciones aquí descritos pueden producirse en un solo teléfono. No requieren que los dos usuarios editen simultáneamente un registro.

## Prioridad alta

### 1. Una edición puede perderse después de una creación cuya respuesta no llegó

**Estado: reproducido con SQLite real y API simulada.**

1. Crear un cliente «First». El servidor lo guarda, pero el móvil pierde la respuesta.
2. El outbox aplaza el reintento 30 segundos y todavía no conoce el ID remoto.
3. Cambiar el nombre a «Second» antes del reintento.
4. La edición vuelve a enviarse como POST. El servidor deduplica y devuelve el cliente anterior sin aplicar el nombre nuevo.
5. El móvil marca la edición como sincronizada. El siguiente pull vuelve a poner «First».

La combinación de rutas de creación deduplicadas y confirmación incondicional también debe revisarse en productos y preventas. La reproducción completa de este caso se realizó con clientes.

**Origen:** [pushClient](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/sync.ts:391>), [deduplicación del backend](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/clients.ts:110>).

**Corrección propuesta:** recuperar el ID remoto y confirmar mediante PUT el estado local pendiente antes de dar por resuelta su edición. Una respuesta deduplicada confirma la creación original, no necesariamente los cambios posteriores.

### 2. La respuesta de un envío antiguo puede confirmar cambios que todavía no se enviaron

**Estado: reproducido con clientes y preventas en SQLite real.**

Si se modifica un registro mientras una petición anterior sigue en vuelo, el ACK anterior establece `sync_status='synced'` sin comprobar si hay una operación posterior pendiente. Si la app se interrumpe antes del push adicional, al arrancar el pull puede sobrescribir esa edición.

Caso probado: preventa de una unidad por 1000 centavos; durante el envío se cambia a dos unidades/2000 centavos. Tras el ACK queda localmente `2000/synced` con otra operación pendiente. El siguiente pull y push terminan en `1000/synced`, cantidad remota 1 y ambos eventos `done`.

El drenaje habitual del contexto de sincronización reduce esa ventana; no elimina el fallo ante una interrupción.

**Origen:** [markOrderSynced](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/orders.ts:635>), [markClientSynced](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/clients.ts:203>), [confirmación del pedido](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/sync.ts:747>).

**Corrección propuesta:** confirmar la versión/evento enviado; conservar `pending` si existe un cambio posterior. El pull debe comprobar también el outbox pendiente, además del campo `sync_status`.

### 3. Los favoritos pueden provocar que falle la sincronización completa

**Estado: reproducido con SQLite real.**

1. Crear un producto local, marcarlo favorito y sincronizarlo.
2. La estrella aparece activa, pero el filtro de favoritos devuelve una lista vacía.
3. Intentar quitar la estrella crea otro favorito, uno con ID local y otro con ID remoto.
4. El siguiente remapeo falla con `UNIQUE constraint failed: product_favorites.product_id`.

Esto interrumpe el pull; en una sincronización completa puede impedir llegar al envío del resto del outbox.

**Origen:** [toggle](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/products.ts:38>), [filtro](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/products.ts:195>), [remapeo](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/products.ts:557>).

**Corrección propuesta:** usar una identidad coherente para favoritos y resolver las colisiones antes de remapear, conservando una sola fila.

## Prioridad media

### 4. Sincronizar un combo recién creado puede duplicar su definición local

**Estado: reproducido con SQLite real.**

El push remapea primero el `product_id` de la definición al ID remoto; el UPDATE siguiente busca todavía el ID local o el antiguo remoto. No confirma esa definición y el pull crea otra. Al editar se modifica una fila, mientras la lectura puede devolver la otra.

Caso probado: tras alta + push + pull hay dos definiciones activas. Se configura máximo 2 y `getProduct` devuelve máximo 1. Esto puede mostrar reglas antiguas o generar pedidos incompatibles con el servidor.

**Origen:** [orden de remapeo/confirmación](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/sync.ts:497>), [upsert de definición](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/sync.ts:135>), [hidratación](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/products.ts:146>).

**Corrección propuesta:** reconocer el ID de producto local y remoto al resolver la definición; reconciliar los duplicados conservando la edición pendiente y garantizar una sola definición vigente por producto.

### 5. Renombrar una presentación puede romper los combos que la utilizan

**Estado: reproducido ejecutando el helper real del backend con SQL simulado.**

El móvil envía las presentaciones sin ID. El servidor las empareja por nombre. Cambiar «Unidad» por «Bolsa» desactiva la presentación anterior y crea una nueva; las opciones de otros combos siguen apuntando al ID inactivo. Al venderlos se rechaza la opción. También afecta pedidos offline que conservan el ID anterior.

**Origen:** [payload móvil](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/sync.ts:477>), [emparejamiento por nombre](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/catalog.ts:255>).

**Corrección propuesta:** enviar y conservar IDs estables al editar una presentación. Renombrar no debe equivaler a eliminar y crear otra.

### 6. Cancelar la selección de un combo y abrir otro conserva opciones ocultas

**Estado: reproducido ejecutando el componente real con un harness de estado; no es una prueba en teléfono físico.**

Elegir una opción del combo A, cerrar con X sin agregarlo y abrir el combo B conserva `selectedCounts`. El contador puede considerar válida la selección aunque las opciones pertenezcan a A. Se logró agregar B con cero opciones cuando exigía una. SQLite acepta esa línea y el backend después rechaza la preventa.

**Origen:** [estado del selector](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/components/ComboSelectorModal.tsx:25>), [construcción de selecciones](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/components/ComboSelectorModal.tsx:88>).

**Corrección propuesta:** reiniciar selección y cantidad al cambiar/cerrar el combo y validar únicamente opciones del combo actual. Añadir validación local de combos antes de guardar el pedido.

### 7. El historial confunde el ID remoto de la jornada con el local

**Estado: reproducido con repositorios de producción y SQLite real.**

El historial cargado por HTTP utiliza el ID remoto. Si posteriormente falla la petición de preventas, llama al repositorio local con ese ID. El repositorio busca la jornada solo por `id`, por lo que puede mostrar cero preventas aunque estén en SQLite bajo el UUID local.

La eliminación local usa también el ID remoto y puede no borrar la copia local, que reaparece offline hasta recibir su tombstone. La reproducción obtuvo una preventa con el ID local, cero con el remoto y una jornada restante después del borrado por el ID remoto.

**Origen:** [fallback del historial](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/screens/HistoryScreen.tsx:50>), [borrado](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/screens/HistoryScreen.tsx:79>), [consulta local](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/orders.ts:139>).

**Corrección propuesta:** resolver `id OR server_id` antes de consultar/borrar; invalidar las listas expandidas del historial cuando se actualicen sus datos.

### 8. El autocierre desde el pull no conserva una transacción entre sus consultas

**Estado: fallo estructural confirmado por revisión; el intercalado financiero no se reprodujo contra PostgreSQL real.**

`/sync/pull` llama al helper de autocierre sin `BEGIN` y sin el lock compartido de jornadas. El helper hace primero `SELECT ... FOR UPDATE` y después otra consulta que consolida y cierra. En autocommit, el bloqueo del SELECT ya terminó al iniciar la segunda consulta. Una subida offline intercalada puede producir un cierre con un total calculado antes de confirmar ese pedido.

**Origen:** [llamada desde pull](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/sync.ts:226>), [helper de autocierre](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/workdays.ts:51>).

La interpretación del autocommit y de los snapshots se contrastó con la documentación de [BEGIN](https://www.postgresql.org/docs/current/sql-begin.html) y [Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html).

**Corrección propuesta:** envolver llamada, lock y cierre en una transacción como ya hace `/workdays/current`. Añadir una prueba de integración con dos conexiones PostgreSQL en un entorno aislado.

### 9. Una base nueva creada con las migraciones carece de una columna que exige crear clientes

**Estado: discrepancia comprobada en el esquema versionado; no indica que falle la base actualmente desplegada.**

El INSERT de clientes utiliza `assigned_user_id`, pero ninguna migración del runner crea esa columna. En una instalación nueva esa ruta puede responder con el error PostgreSQL `42703`. La base actual puede conservar la columna de un esquema anterior.

**Origen:** [INSERT de clientes](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/clients.ts:122>), [esquema inicial](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/scripts/migrate.ts:54>).

**Corrección propuesta:** alinear el esquema y la ruta con una migración idempotente; probar un arranque completo sobre una base vacía.

## Casos menores

### 10. El reparto de centavos de combos puede asignar un importe negativo

**Estado: reproducido con el generador Excel real y un Workbook capturado.**

Caso extremo válido: combo de Bs. 0,02 con cuatro opciones iguales. Se obtienen Bs. 0,01, 0,01, 0,01 y **−0,01**. El total general sigue en Bs. 0,02; el error está en el reparto entre componentes. El consolidado móvil aplica la misma fórmula.

**Origen:** [reparto en Excel](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/services/excel.ts:228>), [consolidado móvil](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/db/repositories/orders.ts:236>).

**Corrección propuesta:** reparto mediante cocientes enteros y residuos, o redondeo acumulativo, conservando suma exacta y componentes no negativos.

### 11. La limpieza de reportes puede borrar una carpeta mientras se genera un archivo

**Estado: reproducido con la ruta real, Express y filesystem simulado.**

El GC verifica antigüedad, pero no las generaciones presentes en `reportsInFlight`. Si un reporte tarda en generarse y otra petición activa el GC, puede borrarse su carpeta vencida antes de que escriba el Excel. Se reprodujo una respuesta `500 ENOENT`; reintentar permite regenerar el archivo.

**Origen:** [limpieza](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/reports.ts:61>), [generaciones en vuelo](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/reports.ts:19>).

**Corrección propuesta:** excluir carpetas en uso o coordinar generación y GC con un estado común.

## Optimizaciones y mantenimiento que sí aportan

1. **Guardar primero en SQLite y sincronizar después.** La pantalla espera `/workdays/current?fresh=1` antes de persistir el pedido y luego espera `pushSync`. Con una conexión lenta, el primer paso puede consumir el timeout de 60 segundos. La reproducción de la función real confirmó cero escrituras mientras la petición permanecía pendiente. Conviene confirmar el guardado local inmediatamente y presentar por separado cualquier conflicto de jornada al sincronizar. Fuente: [executeSaveOrder](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/screens/NewSaleScreen.tsx:416>).
2. **Agrupar consultas e inserciones de pedidos.** El backend hace dos SELECT por línea y al menos un INSERT posterior por cada una: 100 líneas implican más de 300 consultas mientras se conserva el lock de jornadas. Reducir los viajes a Neon es más útil aquí que añadir infraestructura. Fuente: [make](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/orders.ts:106>).
3. **Unificar eventos pendientes del mismo registro.** Varias ediciones offline generan varios envíos del mismo estado final. Se pueden consolidar respetando altas, bajas, cancelaciones y la versión realmente enviada. Esta optimización debe hacerse junto con las correcciones 1 y 2.
4. **Evitar leer todos los respaldos completos para mostrar la lista.** Actualmente se abre y parsea cada JSON. Un índice pequeño con fecha y cantidades haría la lista más rápida. Añadir gestión manual de copias antiguas ayudaría a controlar el espacio conservando las copias necesarias para recuperar pendientes. Fuente: [listLocalBackups](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/mobile/src/services/localBackup.ts:93>).
5. **Revisar el ajuste temporal del contador.** La ruta permite retroceder respecto de boletas ya emitidas y el esquema inicial no exige números únicos. Conviene impedir retrocesos accidentales y distinguir «último número emitido» de «cantidad de preventas»: una secuencia puede tener saltos. Fuente: [receipt-counter](<C:/Users/PC/Desktop/Proyecto final/PreventaPro_actualizado/PreventaPro/backend/src/routes/settings.ts:27>).
6. **Compartir la regla de jornadas cerradas.** `/orders` admite una tolerancia de una hora o coincidencia de fecha UTC; `/sync/push` usa quince minutos. La recuperación offline debería seguir la misma regla en ambos endpoints y usar la fecha de Bolivia.
7. **Estabilizar las pruebas de temporizadores y añadir regresiones de estos escenarios.** La prueba `[A-16]` de `performance_features.test.ts` reproduce un patrón antiguo de sincronización con esperas reales de 20, 10 y 50 ms. Falló una vez y pasó al repetir; conviene usar promesas controladas o temporizadores simulados, y mantener pruebas sobre funciones reales.
8. **Aclarar las cantidades de componentes de las boletas.** Para dos combos con tres papas cada uno se muestra «Combo: 2» y «Papa: 3»; el consolidado muestra seis. Explicitar «por combo» evita ambigüedad. No se clasificó como importe financiero incorrecto.

## Verificaciones y límites

- Backend: **148/148 pruebas** aprobadas.
- Móvil: primera ejecución **133/134**, con un fallo de temporización en la prueba simulada `[A-16]`; repetición completa **134/134** aprobada.
- TypeScript: sin errores en backend y móvil.
- Se volvieron a ejecutar las reproducciones de sincronización, favoritos, definiciones de combos, selector, historial, renombrado de presentaciones, reparto y GC.
- Autenticación: no se detectó otro fallo práctico en conservación de sesión offline ni en preservación de SQLite ante errores de red/401.
- Se descartó un supuesto timeout del cuerpo HTTP porque el `fetch` de React Native 0.74 entrega la respuesta tras recibir el cuerpo; un mock de fetch de navegador no representaba el APK actual.
- No se ejecutaron pruebas en teléfono físico, ni carreras sobre PostgreSQL real, ni cambios en producción. Los resultados locales no garantizan ausencia de otros bugs.

**Orden sugerido:** corregir primero 1, 2 y 3; después 4, 5 y 6; luego historial y transacciones de jornadas. Mantener las pruebas que reproducen cada fallo antes de preparar otra versión.

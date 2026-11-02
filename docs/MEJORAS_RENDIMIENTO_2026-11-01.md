# Correcciones de carga y sincronización — 1 de noviembre de 2026

Se aplicaron las correcciones de la auditoría del 31 de octubre. El guardado sigue confirmándose primero en SQLite; se mantienen precios históricos, revisión del catálogo, conflictos, snapshots/ACK y funcionamiento compartido para la pareja. No se añadieron dependencias ni se cambiaron tokens o sesiones.

## Cambios aplicados

| Hallazgo | Resultado |
| --- | --- |
| Categorías esperan la sincronización | Alta, edición y baja liberan la interfaz después de confirmar la escritura local. El envío continúa en segundo plano. Se comprobó crear inmediatamente un producto con esa categoría: el envío respeta categoría → producto y resuelve su identificador remoto. |
| Consulta de jornada antes de enviar cualquier entidad | Una cola vacía no hace peticiones. Clientes, categorías y productos no consultan la jornada. Las preventas conservan su resolución cuando corresponde. Cerrar una jornada vacía solicita su identificador sólo si falta y verifica la fecha. |
| Un fallo del pull bloquea el push | Se separaron ambas fases. Un fallo de descarga permite intentar enviar pendientes; autenticación bloqueada o limitación de peticiones no disparan envíos innecesarios. La interfaz conserva el error de descarga hasta actualizar realmente los datos, aunque un envío posterior termine bien. |
| Listas que desaparecen al refrescar | La pantalla de venta mantiene las filas de la misma consulta durante una recarga o fallo. Cambiar de filtro/cliente sigue invalidando resultados anteriores. El catálogo sólo emite una revisión cuando cambia contenido aplicado, no por acabar un sync vacío o por un ACK. |
| Editor de producto carga todo el catálogo | Se carga primero el producto elegido. El selector de opciones de combo consulta productos normales al abrirse, en páginas de 50 y con búsqueda. Hay estados visibles de carga y error con reintento. |
| Historial espera la red para recuperar el detalle | Se conservan los detalles y se leen los pedidos locales antes de esperar la lista remota. Los envíos sin pull no recargan el historial. Se mantienen identificadores locales/remotos estables y se ignoran respuestas de solicitudes anteriores. |
| Recientes consulta dos veces | El filtro y su contador comparten la lectura en curso. La reserva se libera al terminar para no reutilizar una respuesta anterior a un guardado o regreso a la pantalla. |
| Refresco y recuperación completa mezclados | `forceSync()` refresca incrementalmente sin esperar el intervalo automático. La herramienta de recuperación usa explícitamente `forceSync({ fullRecovery: true })`; el reinicio conserva su descarga completa. Se quitaron consultas de jornada duplicadas. |
| Listas secundarias renderizan todo | Inicio muestra las ocho preventas recientes con acceso al listado completo. El consolidado de productos usa FlatList. El detalle del historial muestra páginas de diez preventas sin perder las demás. |
| Descargas de reportes se bloquean entre sí | Las descargas comparten una reserva de lectura; limpieza y eliminación conservan exclusión y esperan a los lectores. Los archivos se reutilizan por versión de jornada y diseño, se deduplica la generación y se mantienen versiones inmutables para no reemplazar un archivo que otro teléfono esté descargando. |

El número `layoutVersion` de `backend/src/routes/reports.ts` debe actualizarse al cambiar el diseño de un reporte para invalidar sus copias. Las versiones antiguas permanecen protegidas durante las descargas y se retiran con la limpieza de la carpeta de jornada.

La detección de cambios compara datos de clientes, categorías, productos, presentaciones y combos. Un snapshot completo de opciones desactiva sólo las ausentes; ya no desactiva y reactiva todas las opciones en cada descarga. Las asociaciones ya conocidas no vuelven a recorrer todas las referencias, y se conserva la normalización de favoritos antiguos.

## Controles conservados

- La validación previa de catálogo sigue teniendo su límite de ocho segundos y las decisiones explícitas de precios y guardado sin verificar. El carrito muestra qué está haciendo al guardar. No se eliminó esta protección para aparentar un guardado más rápido.
- Una respuesta antigua no confirma ediciones posteriores. El outbox conserva sus dependencias y envíos serializados; no se introdujo concurrencia sin límites.
- Los respaldos y la sustitución de datos conservan sus garantías de copia verificada y exclusión.
- El transporte HTTP sigue siendo asíncrono. No se cambió el timeout basándose en la simulación que no reproducía un fallo de descarga en React Native.

## Verificación

Entorno: Node.js 24.22.1.

| Comprobación | Resultado |
| --- | --- |
| Móvil, Jest completo | 22 suites, **354/354 pruebas**, ninguna omitida |
| Backend, Vitest completo | 16 suites, **233/233 pruebas**, ninguna omitida |
| Tipos del móvil | `tsc --noEmit`: exit 0 |
| Compilación del backend | `tsc -p tsconfig.json`: exit 0 |
| Exportación Android/Hermes | Exit 0; 827 módulos, bundle de aproximadamente 2,58 MB |

Las comprobaciones nuevas cubren envío con pull fallido, ausencia de peticiones con cola vacía, categoría seguida de producto, ausencia de recargas por un catálogo idéntico, conservación de favoritos/aliases, recientes sin duplicación, cargas de producto con recuperación, paginación de opciones y detalle histórico, cierre de jornada vacía y descargas simultáneas protegidas frente a GC. También se actualizaron las dos expectativas antiguas del resumen de pendientes y se añadió un caso de conflicto real en SQLite.

Los resultados locales de Jest están en `mobile/.expo/performance-fixes-tests-2026-11-01.json`. La exportación está en `mobile/.expo/performance-fixes-export-2026-11-01`; es un bundle de comprobación, **no un APK instalable**.

## Límites de esta entrega

El backend se publicó en Render el 1 de noviembre de 2026: commit `224ad8a5dd2fbece188c6911f5b9a158ba006a82`, despliegue `dep-dbjsatjbc2fs73drmb10`, estado **Deploy succeeded | Live**. El servicio compiló y arrancó correctamente; `/api/health` respondió HTTP 200 con `{"ok":true,"service":"preventapro-backend"}`. [Ver despliegue](https://dashboard.render.com/web/srv-dadqrmv40ujc73ckbni0/deploys/dep-dbjsatjbc2fs73drmb10).

No se generó un APK con EAS. No se midieron tiempos o cuadros por segundo en teléfonos físicos ni se atribuyó una mejora numérica a las optimizaciones. Para comparar en los teléfonos, repetir las mismas acciones y revisar Mi cuenta → Mediciones de rendimiento; comprobar también el APK antes de dar por validado el comportamiento final de Android.

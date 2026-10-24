# Correcciones de la auditoría — 24 de octubre de 2026

Se corrigieron en el código local los 11 hallazgos de [la auditoría](AUDITORIA_2026-10-23.md) y las mejoras de mantenimiento asociadas. Esta revisión no cambia la versión de la app ni publica un APK. No se modificó la base de producción.

## Hallazgos corregidos

| N.º | Problema | Corrección y comprobación |
| --- | --- | --- |
| 1 | Ediciones perdidas tras una creación cuya respuesta se perdió | Las altas usan identidades locales estables. Cuando una respuesta deduplica una creación, se confirma mediante PUT el estado capturado si corresponde. Regresiones con clientes, productos y preventas sobre SQLite real y HTTP simulado. |
| 2 | Un ACK antiguo confirma cambios posteriores aún no enviados | El payload y los IDs de eventos pendientes se capturan en la misma transacción local. Solo se completan esos eventos; las ediciones posteriores siguen pendientes y el pull las protege consultando también el outbox. Regresiones con ediciones durante peticiones en vuelo. |
| 3 | Favoritos con IDs locales/remotos divergentes y colisiones UNIQUE | Lecturas, filtros, toggles y remapeos reconocen aliases y conservan una única identidad local, eliminando colisiones previas. Regresión de sincronizar, filtrar, quitar y volver a sincronizar. |
| 4 | Definiciones de combos duplicadas después de sincronizar | La selección y reconciliación de definiciones consideran ambos IDs y priorizan los cambios locales pendientes; los IDs remotos se asocian a la definición capturada. Regresión de creación, remapeo, edición y pull sin duplicados. |
| 5 | Renombrar una presentación cambia su identidad | El móvil envía el ID remoto y un localId estable para altas/reintentos. El servidor actualiza la misma presentación, permite intercambiar nombres y conserva compatibilidad por nombre con APKs anteriores. Regresiones móviles y de catálogo backend. |
| 6 | El selector conserva opciones de otro combo | Cada apertura/producto/presentación reinicia selección, búsqueda y cantidad. Solo cuentan las opciones actuales; callbacks anteriores no pueden agregar otro combo. SQLite rechaza selecciones vacías, ajenas o fuera de límites sin guardar cabeceras ni outbox parciales. |
| 7 | Historial consulta o elimina una jornada usando el alias incorrecto | Los repositorios resuelven IDs locales/remotos. El historial muestra SQLite antes de consultar la red, recarga las preventas al reabrir o sincronizar y descarta respuestas antiguas. Antes del DELETE remoto verifica que no haya pendientes locales. |
| 8 | Autocierre del pull sin transacción/lock compartido | El pull ejecuta BEGIN, lock de jornadas, autocierre y COMMIT antes de invalidar cachés y descargar el delta. Un fallo produce ROLLBACK. Se verifican el orden de consultas y la liberación de conexión. |
| 9 | Esquema nuevo sin clients.assigned_user_id | El esquema inicial incluye la columna y la migración aditiva 010_clients_assigned_user la añade a bases existentes, con un índice. Se verifica el SQL de ambas rutas de instalación. |
| 10 | Reparto de combos con centavos negativos | Backend y móvil comparten una fórmula idéntica de cocientes y residuos enteros. El reparto usa BigInt para evitar desbordes intermedios, nunca asigna importes negativos y conserva la suma exacta. Once escenarios iguales en ambas suites y verificación de archivos reales. |
| 11 | GC borra reportes mientras se generan/descargan | Generación, descarga, borrado de jornada y GC comparten un lock por carpeta. Se mantiene hasta el callback de descarga y GC vuelve a revisar la antigüedad dentro del lock. Se prueba con filesystem real y generadores/descargas controlados. |

## Optimizaciones incluidas

- La venta se confirma después de guardar SQLite y el outbox. El envío continúa en segundo plano; una conexión lenta no bloquea el guardado. El bloqueo contra doble toque se conserva y se prueba con una escritura pendiente.
- Ambas rutas de pedidos leen catálogo por conjuntos e insertan detalles/selecciones por lotes dentro de su transacción. Para 100 líneas normales, las pruebas comprueban dos consultas de catálogo y un INSERT de detalles, en lugar de consultas por línea.
- Una petición que transmite el estado actual de una entidad completa los eventos que capturó juntos. Las ediciones offline acumuladas evitan enviar repetidamente el mismo estado y los eventos posteriores permanecen pendientes.
- Las copias de seguridad tienen índices pequeños recuperables para mostrarlas sin leer todos los JSON completos. La limpieza es manual; una copia con pendientes exige una exportación externa verificada antes de eliminarla. La importación escribe y valida un temporal antes de moverlo a su destino definitivo.
- Los envíos solicitados durante mantenimiento se retoman al terminar. Una sincronización completa solicitada mientras hay respaldo/envíos espera a que se liberen todas esas tareas y ejecuta su pull forzado.
- El correlativo no puede retroceder por debajo de una boleta existente. La cantidad histórica usa COUNT; lastReceiptNumber expresa el último correlativo, y la pantalla usa el campo adecuado al ajustarlo.
- /orders y /sync/push usan la misma excepción para recuperar altas offline de jornadas cerradas: con closed_at válido, captura anterior o hasta 15 minutos después del cierre; sin closed_at válido, coincidencia de día en Bolivia. Esta excepción no habilita editar pedidos de jornadas cerradas. La fecha de jornada explícita sigue sirviendo para resolver capturas históricas.
- La prueba A-16 utiliza temporizadores simulados. Los casos del Provider real usan promesas controladas.
- Los desgloses PDF y Excel aclaran que las cantidades de las opciones son «por combo», conservando columnas, nombres de archivo y rutas.
- Los reportes se regeneran bajo demanda para reflejar cambios de clientes y direcciones. No se añadió una caché persistente cuya invalidación pudiera dejar datos antiguos.

## Validación

- Backend: **194/194 pruebas** en 12 suites.
- Móvil: **181/181 pruebas** en 12 suites, incluidas integraciones con SQLite real usando Node.js 24.
- TypeScript: `tsc --noEmit` sin errores en ambos paquetes.
- Exportación Android con Expo y compilación Hermes completadas. Esto valida el bundle; no se generó ni publicó otro APK.
- Se generaron y leyeron archivos PDF/Excel reales en carpetas temporales; se comprobaron totales, reparto de combos, etiquetas y fecha de Bolivia. Las consultas PostgreSQL se controlaron con mocks.
- No se ejecutaron carreras contra PostgreSQL real ni pruebas táctiles en teléfono físico. Esas comprobaciones siguen siendo recomendables antes de distribuir la próxima versión.

## Próximo despliegue

Antes de desplegar el backend actualizado, ejecutar desde backend `npm run migrate` con la conexión correspondiente para aplicar `010_clients_assigned_user`. La migración es aditiva e idempotente; no borra tablas ni registros.

La migración quedó preparada en el repositorio. No se aplicó a Neon durante esta tarea. Tampoco se hicieron commits, push, despliegues ni cambios de versionCode.

# Detalle de pendientes de sincronización

Implementación local del 27 de octubre de 2026.

## Comportamiento

- Inicio muestra el total de cambios sin confirmar, incluidos los errores permanentes. El número de errores ya no se calcula a partir de los cinco últimos mensajes.
- **Ver cambios pendientes** abre una pantalla con paginación local de 30 cambios, nombre del registro, fecha, operación, estado y último motivo de error.
- **Por revisar** muestra los estados `failed` y `error`; **Todos** incluye también `pending` y `syncing`. Los fallos temporales que ya tienen un reintento programado permanecen en Todos, con el motivo y la fecha mínima del siguiente intento. Esa fecha no garantiza un envío inmediato sin conexión o con la app en segundo plano.
- Los conteos corresponden a cambios de la cola, no a registros distintos. Varias ediciones de una preventa pueden producir varias filas.
- Las preventas se abren en Detalle de preventa para mantener las restricciones existentes de jornadas cerradas y pedidos anulados. Clientes y productos activos se abren en sus formularios, y las categorías en el administrador existente.
- Registros eliminados o ausentes conservan sus cambios visibles, sin ofrecer una edición que termine creando un registro vacío. Una preventa anulada existente sí se puede consultar en detalle.
- La consulta funciona sin conexión. Se recarga al volver de un editor, cambiar de filtro, cerrar categorías o finalizar una sincronización.
- Las respuestas antiguas no sustituyen al filtro actual ni se aplican después de abandonar la pantalla. Si falla un filtro nuevo, no reaparecen filas del filtro anterior.

## Alcance técnico

Se añadieron consultas SQLite de solo lectura para resumen y detalle, una pantalla, una ruta y ayudas de presentación. No requiere migración de esquema ni despliegue de backend. Las reglas de envío, reintentos, confirmaciones, descartes y respaldos conservan su comportamiento existente.

## Verificación

- Consultas probadas con SQLite real: totales de más de cinco errores, todos los estados, páginas con fechas iguales, nombres y referencias, registros ausentes/inactivos y límites de página.
- Provider probado con conteos completos, errores permanentes sin conexión y consulta local sin lanzar sincronización.
- Revisión de rutas y protecciones de edición existentes.
- Suite móvil completa con Node 24.22.1: **16 suites y 298 pruebas correctas**, incluidas las pruebas de SQLite real, coordinación de tareas, filtros, paginación y respuestas tardías.
- TypeScript: `tsc --noEmit` correcto.
- Exportación Android con Expo y bytecode Hermes correcta (816 módulos). El resultado local está en `mobile/.expo/sync-details-export/`; esta exportación verifica el empaquetado y no es un APK instalable.
- Las comprobaciones automatizadas y el empaquetado Android no sustituyen una prueba táctil en un teléfono.

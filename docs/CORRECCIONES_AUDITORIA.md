# Correcciones de la auditoría de PreventaPro

## Los 16 hallazgos

1. **Descargas incompletas por expulsión de caché:** el pull construye la respuesta con mapas propios, aunque haya más de 25 jornadas o pedidos. La caché sigue teniendo un tamaño limitado.
2. **Duplicados al perder una confirmación HTTP:** el móvil reconoce `idempotency_key`, conserva el UUID local y reconcilia copias antiguas sin duplicar totales ni borrar ediciones pendientes. Las cancelaciones sin ID remoto también se confirman por la clave original.
3. **Rescate que anulaba preventas offline:** la sincronización forzada conserva los pedidos y sus líneas, transmite la fecha de captura y permite recuperar jornadas históricas creadas completamente offline. Un conflicto de jornada conserva la preventa e informa el error.
4. **Pull que sobrescribía clientes/categorías pendientes:** primero se protege el estado local pendiente y se resuelven sus referencias; su contenido se envía mediante el outbox.
5. **Pedido confirmado sin outbox:** crear, editar o cancelar guarda también el evento de sincronización en la misma transacción SQLite. Se recuperan pedidos huérfanos de versiones anteriores, excluyendo los descartados explícitamente.
6. **Precio antiguo en el selector:** la fila guarda la selección por ID y obtiene el objeto vigente del catálogo. El catálogo se recarga al recibir cambios de sincronización.
7. **Opciones eliminadas de combos que reaparecían:** el servidor identifica el snapshot completo de opciones y el móvil desactiva opciones ausentes, respetando ediciones locales pendientes.
8. **Bajas que no llegaban al otro teléfono:** el pull incluye entidades inactivas y jornadas eliminadas mediante tombstones. Antes de aplicar una baja se integran las reubicaciones de pedidos; si hay datos pendientes se conservan y se informa el conflicto.
9. **Campos opcionales de cliente que no se vaciaban:** los campos eliminados se transmiten explícitamente como `null`.
10. **Paginación defectuosa de PDF:** altura de filas calculada según el texto, páginas de continuación y encabezados repetidos. Las pruebas reales de 40 y 50 líneas producen dos páginas y conservan el total.
11. **Errores temporales que agotaban ocho intentos:** se reintentan sin límite, con espera creciente de 30 segundos a 15 minutos. Las validaciones permanentes se mantienen separadas y no bloquean otros registros válidos.
12. **Conexiones fallidas que dejaban peticiones sin respuesta:** adquisición de conexiones y handlers asíncronos protegidos; los fallos temporales responden como errores reintentables. El orden de locks de pedidos coincide con el usado en sincronización y jornadas.
13. **Repetir una cancelación devolvía error:** cancelar un pedido ya cancelado devuelve éxito, incluso si después se cerró la jornada, sin recalcular ni cobrar otra vez.
14. **Consolidado móvil distinto del Excel:** se desglosan los componentes de combos y se distribuyen sus centavos con las mismas reglas que la planilla, agrupando por producto/presentación.
15. **Token con sesión inexistente aceptado:** un JWT con `sid` requiere una sesión existente y activa. Si no se logra persistir una sesión al ingresar, no se entrega un token nuevo.
16. **Operaciones de sync ignoradas:** el endpoint por lote aplica ediciones reales de pedidos y bajas de entidades; las operaciones fallidas hacen rollback de su savepoint sin perder las demás operaciones válidas.

## Respaldos y depuración

- **Mi cuenta → Guardar respaldo:** copia todos los datos SQLite de trabajo, incluidos pedidos, combos, favoritos y outbox. No exporta credenciales.
- **Guardar en carpeta / Importar desde carpeta:** permite conservar y recuperar las copias fuera del almacenamiento privado de Android.
- **Restaurar respaldo:** valida formato y columnas, respalda el estado actual y restaura dentro de una transacción. Una copia inválida o una inserción fallida conserva el estado anterior.
- **Reiniciar datos locales:** el respaldo verificado y el borrado comparten la misma transacción y cola de escrituras. Si falla el respaldo, no se reinicia SQLite.
- **Descartar errores:** guarda una copia antes de descartar validaciones permanentes; conserva los errores de conexión pendientes.
- **Depuración automática:** elimina únicamente eventos `done` confirmados hace más de 30 días. No elimina preventas ni eventos pendientes o con error.

## Verificaciones realizadas

- Backend: **148/148 pruebas**, incluidas generación real de PDF/Excel, cancelación repetida, pérdida de confirmación, transacciones y respuestas ante fallos de conexión.
- Móvil: **134/134 pruebas**, incluidas integridad con SQLite real, respaldos/restauración, reintentos, catálogos y coordinación del proveedor de sincronización. El harness de `SyncContext` verifica las funciones públicas y promesas; no simula el render nativo de React.
- TypeScript: sin errores en ambos proyectos.
- Exportación del bundle Android con Hermes: completada; no genera un APK.
- No se realizaron pruebas sobre la base de producción ni una instalación en teléfono de estas modificaciones.

Los tests de SQLite real se ejecutaron con Node.js 24. Los comandos de prueba son los runners configurados por `npm test` en cada paquete.

## Migración y publicación

La migración **`009_sync_tombstones`** está agregada al runner de `backend/scripts/migrate.ts`. Para otros entornos debe aplicarse con `npm run migrate` antes de publicar el backend actualizado.

Al preparar la publicación solicitada de **1.0.2** (Android `versionCode: 3`), se comprobó el SQL exacto dos veces en un esquema aislado y se revirtió el ensayo. Después se aplicó únicamente la migración009 en la base Neon configurada, mediante la conexión directa y una transacción. Se verificaron la tabla y el registro en `_migrations`, sin modificar pedidos ni clientes.

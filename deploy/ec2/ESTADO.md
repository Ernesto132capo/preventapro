# Estado de la preparación de EC2 — 2 de noviembre de 2026

## Servidor

- Región `us-east-2`; instancia `i-0a3cbf8f99989b78e`, `PreventaPro-pruebas`, `t8i.small`.
- IP elástica `18.227.163.204`.
- Ubuntu 24.04 actualizado, PostgreSQL 18.6 local, Node 24 y npm instalados. El clúster 16 original, sin datos de aplicación, está conservado y detenido con inicio manual.
- Usuario de servicio `preventapro` sin sudo ni shell; configuración operativa reservada a root.
- Nginx, certificado público para la IP y renovación automática configurados.
- `/healthz` responde `host-ready`; el backend desplegado responde en `https://18.227.163.204/api/health`.
- Swap de 1 GiB, límites de logs y actualizaciones automáticas del sistema/NodeSource.
- Timers: salud cada cinco minutos; respaldo diario 06:00 UTC (02:00 Bolivia, margen de cinco minutos); revisión de dependencias semanal.

## Recursos creados y comprobados

- Bucket `preventapro-backups-843780049320-us-east-2`, privado, ACL deshabilitadas, SSE-S3, versiones habilitadas y política que exige TLS.
- Prefijo de copias `postgresql/preventapro/`: vencimiento a 30 días; versiones no actuales se eliminan siete días después; cargas incompletas caducan al día.
- Política `PreventaProBackupAndAlerts`, rol y perfil `PreventaProEc2Ops`, asociados a la instancia con autorización explícita del usuario.
- El rol solo permite listar el prefijo de copias, escribir/leer sus objetos y publicar en `PreventaPro-alerts`. No permite borrar objetos ni administrar AWS.
- Tema SNS `arn:aws:sns:us-east-2:843780049320:PreventaPro-alerts` con correo confirmado. Publicación de prueba desde EC2 correcta.
- Alarmas CloudWatch con notificaciones al tema anterior: `PreventaPro-CPUHigh` (media >=85, 3 periodos de cinco minutos), `PreventaPro-CPUCreditsLow` (mínimo <=12, 3 periodos) y `PreventaPro-InstanceStatus` (máximo >=0.99, 2 periodos). La métrica de estado es binaria; 0.99 detecta el valor 1.
- Las tres alarmas aparecían `CORRECTO` tras crearlas. Solo notifican: no reinician, detienen ni terminan instancias.
- Política DLM `policy-04269200484beb9e8`, habilitada para instancias con `Backup=PreventaPro`, incluye el volumen raíz, diaria a partir de las 09:00 UTC (05:00 Bolivia), retención máxima de siete snapshots.
- Primera snapshot `snap-055e83ceb70e07da4`: completada, cifrada, disco de 30 GiB, iniciada el 2 de noviembre a las 05:30 de Bolivia. DLM ejecuta la copia dentro de una ventana posterior al inicio de la programación.
- Presupuesto `PreventaPro-monthly-30USD`: mensual para toda la cuenta, sin créditos/reembolsos; aviso real >80% (24 USD), previsto >100% (30 USD). Sin acciones automáticas. La verificación de email de Budgets estaba pendiente al crear el presupuesto y es independiente de SNS.

## Pruebas realizadas

- Copia y restauración local de dos filas sintéticas, con texto Unicode y centavos enteros: correcta.
- Copia a S3, descarga, verificación SHA-256 y restauración de esas filas: `BACKUP_RESTORE_OK=S3`.
- Solo se crearon y eliminaron bases temporales de prueba; no se importaron datos reales.
- HTTPS validado desde EC2 y desde el equipo local; ensayo de renovación con recarga de Nginx correcto.
- Verificación de unidades systemd correcta; comprobación de salud sin incidencias. Aproximadamente 1.4 GiB disponibles y 13.8% del disco utilizado en la última comprobación.

## Migración completada en EC2

- Origen verificado: Neon PostgreSQL 18.6. El usuario confirmó que aún son datos de prueba, sin ventas reales en curso.
- Exportación consistente y solo lectura de las 16 tablas de `public`; copia protegida en EC2, en S3 bajo `postgresql/preventapro/migrations/` y en el equipo local fuera del repositorio.
- Archivo fuente `neon-source-20261102T173025923Z.dump`, 63 419 bytes; SHA-256 `c377896f68b1f295cf8c6564593f1692a8e789c64624cfbbca64c1745f403630`.
- Todas las tablas restauradas coinciden por cantidad y digest de contenido. Incluye 2 usuarios, 52 clientes, 66 productos, 17 pedidos y 5 jornadas; también registros inactivos y sesiones.
- Backend instalado a partir del paquete SHA-256 `f52340ac83f24097343be8328621a9bfae2e8f86f00c4dfae241c0e08edbb42d`. Compilación y 233 pruebas aprobadas tanto localmente como en EC2/Node 24; otras 9 pruebas del simulador aprobadas.
- Servicio `preventapro` activo y habilitado. PostgreSQL solo escucha en localhost; el backend usa el socket Unix y autenticación peer del usuario de servicio, sin una contraseña nueva de base de datos.
- La configuración visible de Render confirmó el mismo origen Neon y rol que la exportación. Se reutilizó su clave de firma existente en EC2, porque difería del archivo local; este último también quedó alineado. Los valores no se incluyeron en registros ni en el repositorio. La misma verificación autenticada pasó en Render y EC2 con el catálogo esperado, sin cambiar contraseñas ni la configuración de Render.
- API pública comprobada por HTTPS: salud, usuario autenticado, categorías, productos, clientes, historial, estadísticas, detalle de pedido y validación de un borrador. Devuelve 63 productos activos y 48 clientes activos.
- Jornada sintética aislada en EC2 completada: 100 preventas, 5 ediciones, 2 cancelaciones y 4 reportes. No se mezcló con la base migrada. Resultado en `/var/lib/preventapro-ops/workday-validation.json`.
- Respaldo de la base migrada descargado de S3 y restaurado en una base temporal: las 16 tablas coinciden. SHA-256 `62a33e1c28ef249e7b1644a7f1443d9b9325101d4ed51bc05a5ce9efd35d1846`, 106 243 bytes. Resultado en `/var/lib/preventapro-ops/backup-verification.json`.
- Copias diarias activadas mediante `/etc/preventapro/backup.enabled`; próxima ejecución a partir de las 02:00 de Bolivia.
- Comprobación de salud final sin incidencias, aproximadamente 1.3 GiB de RAM disponibles y 24 GiB de disco libres.
- Móvil configurado para EC2 en el entorno local y ambos perfiles EAS; versión 1.0.3, Android versionCode 4. Typecheck y 354 pruebas aprobadas en Node 24, sin omitir SQLite.
- Archivo enviado a Expo inspeccionado: 67 archivos, sin `.env`, claves ni respaldos. Incluye el núcleo de precios compartido necesario para Metro.
- El primer APK, build `c47901ea-88c1-497f-84c2-c31e3ed80de3`, sí comenzó a compilar y falló el 2 de noviembre a las 14:32 de Bolivia: `:expo-sqlite:downloadSQLite` devolvió `java.net.SocketException: Network is unreachable`.
- Archivo oficial SQLite 3450300 incluido en `mobile/vendor/sqlite/`, SHA-256 `ea170e73e447703e8359308ca2e4366a3ae0c4304a8665896f068c736781c651`. No se alteró la versión del motor.
- Se corrigió también el formato de `mobile/assets/icon.png`: era un JPG con extensión PNG. Ahora es PNG, con dimensiones y píxeles decodificados idénticos. Expo Doctor local: 17/17 comprobaciones correctas.
- Archivo del nuevo build inspeccionado: 70 archivos, sin secretos, con hook, SQLite verificado y núcleo compartido de precios.
- Segundo APK solicitado a las 15:06 de Bolivia: build `d928cf76-dad7-4c66-90b7-99542a92f110`. Falló a las 15:48 en la misma tarea de descarga. Los registros confirman que el hook preparó y verificó el archivo, pero Gradle siguió solicitando la URL remota. La comprobación anterior de caché no validaba su uso por la tarea real.
- Corrección del hook: ahora cambia directamente la fuente de `downloadSQLite` por la URI del archivo local verificado. Conserva las tareas originales de descarga/extracción y no depende de una ubicación supuesta de caché.
- Validación local del paso nativo: Gradle 8.8, Java 17 y `gradle-download-task` 5.5.0; tareas extraídas del módulo instalado, directorio de salida distinto y vacío. `downloadSQLite` leyó `file:/.../sqlite-amalgamation-3450300.zip`, `prepareSQLite` extrajo `sqlite3.c` y `sqlite3.h`, y terminó `BUILD SUCCESSFUL`. Es una validación de estas tareas, no una compilación completa del APK. Archivos en `C:/Users/PC/.codex/private/pvpgradle/task-check/`.
- Hook ejecutado dos veces correctamente; nuevo archivo de subida inspeccionado (70 archivos, sin secretos, con el hook actualizado).
- Tercer APK solicitado a las 16:18 de Bolivia: build `21e5c0fe-78a2-4671-b83f-a36e4fb6efb3`, proyecto `@ernestopro123capo/preventapro`, versión 1.0.3 (4), mismas credenciales de firma y caché de compilación limpia. Completado y descargado; firma, paquete, versión y URL de EC2 verificados. SHA-256 del APK: `869a791ae29650ed395a99687153a96d6002c87e7880106255c32518f2c7d214`.
- Seguimiento de descarga reiniciado para el nuevo build en este PC mediante `wait-for-apk.cjs`, sin contratar un plan. Durante un máximo de dos horas consulta el build existente cada minuto. Al terminar, comprueba firma, paquete `bo.preventapro.app`, versión 1.0.3 (4) y URL de EC2 dentro del bundle antes de guardar `C:/Users/PC/Desktop/PreventaPro-1.0.3.apk`.
- Estado del seguimiento: `C:/Users/PC/.codex/private/preventapro-ec2/apk-download-status.json`; `READY` significa descarga y comprobaciones completadas. `NEEDS_REVIEW` indica un error o que se superó el plazo. El PC debe seguir encendido y con conexión; el build de Expo continúa independientemente. El usuario confirmó la instalación y que las pruebas en teléfonos, incluidos offline, sincronización y conflictos, pasaron.

## Cierre de la migración — 2 de noviembre de 2026

- El APK 1.0.3 (4) está instalado y las pruebas físicas fueron confirmadas por el usuario.
- Nuevo respaldo de producción restaurado de S3 a las 18:03 de Bolivia: 16 tablas coinciden; SHA-256 `8645430e4ebf479d0dae9c697671ea0281b5d6cca3a45c08da065f34d711c15b`.
- El backend local ya no usa Neon. Usa `preventapro_dev` mediante un túnel SSH local en el puerto 55432, con credenciales y secreto de sesiones propios. Diez migraciones aplicadas y cero pedidos en esta base. Se verificó que el usuario de desarrollo tiene denegado el acceso a producción.
- `verify:ec2` consulta la API desde EC2 mediante SSH, sin depender de Neon ni guardar secretos de producción en el PC. Todas las comprobaciones HTTP resultaron correctas.
- Compilación/backend: 233 pruebas correctas; simulador: 9; móvil: typecheck y 354 pruebas correctas, sin omisiones por versión de Node.
- Render: servicio `preventapro-backend` suspendido y despliegue automático desactivado. Publicar en GitHub no debe volver a desplegar el servicio anterior.
- Neon: proyecto antiguo identificado y confirmado como origen migrado; cómputo suspendido. El borrado definitivo de sus datos queda para la confirmación final.
- La comprobación independiente del correo de AWS Budgets no forma parte del retiro de proveedores; confirmar si todavía está pendiente.

No se ha desplegado CloudFormation. La plantilla describe recursos cuyos nombres ya existen y no debe aplicarse directamente a esta cuenta. Los archivos de entorno, claves y respaldos están fuera de Git. Las cuentas y las sesiones de los teléfonos no se han cambiado.

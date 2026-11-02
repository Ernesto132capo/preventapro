# PreventaPro

Sistema integral de preventa comercial móvil con arquitectura **Offline-First**, diseñado para que preventistas en ruta capturen pedidos, gestionen clientes y consulten catálogos sin depender de conexión continua a Internet.

---

## 🏛️ Arquitectura Offline-First

PreventaPro implementa un ciclo de vida de datos resiliente ante caídas de red o zonas sin cobertura:

```
[Preventista en Ruta]
       │
       ▼
 [SQLite Local] ◄─── Transacciones inmediatas (clientes, productos, pedidos)
       │
       ▼
 [Cola Outbox] ──── Priorización:
                     • Prioridad 1: Entidades maestras (Clientes, Productos, Categorías)
                     • Prioridad 2: Entidades transaccionales (Preventas / Pedidos)
                     • Deduplicación: Éxito en entidad resuelve errores obsoletos
       │
  (Red disponible)
       │
       ├──► POST /api/sync/push ──► Lote de operaciones atómicas
       │                                     │
       │                                     ▼
       │                              [PostgreSQL en EC2]
       │                                     │
       ◄─── GET  /api/sync/pull ◄────────────┘
            (Sincronización incremental con cursores temporales)
```

1. **Persistencia local (SQLite + Expo SQLite):** Todas las operaciones del preventista (crear cliente, registrar preventa, anular pedido) se confirman instantáneamente en SQLite local dentro de transacciones ACID.
2. **Cola de sincronización Outbox:** Cada mutación genera una entrada en la tabla `outbox` con orden de prioridad (las entidades maestras se sincronizan antes que las órdenes dependientes) y control de reintentos (`pending`, `syncing`, `failed`, `error`, `done`). Al tener éxito una operación más reciente de una entidad, se resuelven automáticamente los errores históricos obsoletos.
3. **Invariantes de Jornada Laboral (`WorkDay`):**
   - Un preventista solo puede tener una jornada abierta a la vez.
   - Las jornadas de fechas anteriores abiertas se concluyen automáticamente al iniciar un nuevo día.
   - No se permite crear, editar ni cancelar pedidos sobre jornadas concluidas/cerradas.
4. **Backend Centralizado (Node.js + Express + PostgreSQL):** Procesa lotes de sincronización con límite de 10 MB, valida reglas de negocio (precios en centavos, combos configurables, validación estricta de stockless) y genera reportes en Excel/PDF.

---

## 📦 Estructura del Proyecto

- `mobile/`: Aplicación móvil desarrollada con Expo SDK 51, React Native, TypeScript y SQLite local.
- `backend/`: API REST construida con Express, TypeScript, Zod, Pool de conexiones a PostgreSQL (`pg`), Vitest y scripts de migración.

---

## 🚀 Puesta en Marcha

### Prerrequisitos

- Node.js 24 (necesario también para las pruebas de SQLite real)
- PostgreSQL en EC2 y cliente OpenSSH para el túnel de desarrollo
- Expo Go o emulador Android/iOS (para la app móvil)

---

### 1. Configuración del Backend

#### a. Variables de entorno

Copia el archivo de ejemplo y edita las variables:

```bash
cd backend
cp .env.example .env
```

Parámetros en `backend/.env`:
- `DATABASE_URL`: conexión de PostgreSQL. El desarrollo usa `preventapro_dev` mediante `127.0.0.1:55432`; el servicio de EC2 usa su socket Unix local.
- `AUTH_TOKEN_SECRET`: Secreto criptográfico de al menos 32 caracteres para la firma de JWT. Puedes generar uno seguro con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- `PORT`: Puerto HTTP del servicio (por defecto `4000`).
- `SYNC_FORCE_TTL_MS`: Tiempo mínimo entre pulls forzados (opcional; por defecto `45000` ms).

#### b. Túnel de desarrollo

Configura `EC2_SSH_HOST`, `EC2_SSH_USER`, `EC2_SSH_KEY_PATH`, `EC2_SSH_KNOWN_HOSTS` y `EC2_LOCAL_DB_PORT`, según `.env.example`. La clave privada y la huella verificada quedan fuera de Git.

Desde `backend`, ejecuta `npm run db:tunnel` y mantén esa terminal abierta. Solo escucha en `127.0.0.1:55432`. La base `preventapro_dev` está separada de `preventapro`; su usuario tiene bloqueado el acceso a producción y usa credenciales propias. En otra terminal ejecuta las migraciones y `npm run dev`.

#### c. Instalación y Migraciones de Base de Datos

Instala las dependencias y ejecuta el runner unificado de migraciones:

```bash
npm install
npm run migrate
```

> **Nota:** El comando `npm run migrate` es transaccional e idempotente. Crea la tabla de control `_migrations` y aplica en orden:
> 1. Esquema base (`pg.ts`): tablas `users`, `categories`, `clients`, `products`, `orders`, `order_items`, etc.
> 2. Autenticación (`migrate-auth.ts`): columnas de contraseñas scrypt.
> 3. Combos y promociones (`migrate-combos.ts`): `combo_definitions` y `combo_options`.
> 4. Depuración de stock: retiro definitivo del inventario obsoleto.
> 5. Compatibilidad de nombres de clientes y propietarios.
> 6. Alias de acceso legibles para David y Yuma.
> 7. Sesiones revocables por dispositivo (`user_sessions`).
> 8. Normalización de nombres de clientes existentes.
> 9. Registro de jornadas eliminadas (`009_sync_tombstones`) para propagar sus bajas a otros teléfonos.
> Se puede ejecutar múltiples veces seguidas de manera completamente segura.

#### d. Configuración de Contraseñas de Preventistas

Asigna la contraseña a las cuentas de la base de desarrollo:

```bash
npm run user:set-password -- PV001
npm run user:set-password -- PV002
```

*(Reemplaza `PV001` y `PV002` por los códigos reales de tus usuarios).*

#### e. Iniciar en Desarrollo

```bash
npm run dev
```

La API estará escuchando en `http://localhost:4000/api`.

#### f. Ejecutar Pruebas del Backend

```bash
npm test
```

Ejecuta la suite con **Vitest** cubriendo reglas de combos, validaciones de precios e integridad de cálculos.

---

### 2. Configuración de la Aplicación Móvil

#### a. Variables de entorno

Copia el archivo de ejemplo:

```bash
cd mobile
cp .env.example .env
```

Parámetros en `mobile/.env`:
- `EXPO_PUBLIC_API_URL`: URL base de la API.
  - Para pruebas locales con emulador o teléfono físico en la misma red Wi-Fi, utiliza la IP local de tu máquina: ej. `http://192.168.1.50:4000/api`.
  - Para producción o staging: URL HTTPS del backend desplegado.

#### b. Instalación de dependencias

```bash
npm install
```

#### c. Iniciar la aplicación

```bash
npm start
```

O directamente en el emulador de tu preferencia:
```bash
npm run android
npm run ios
```

#### d. Ejecutar Pruebas y Tipado del Móvil

```bash
# Ejecutar suite de pruebas unitarias (Jest)
npm test

# Verificación estricta de tipos de TypeScript
npm run typecheck
```

Las pruebas cubren:
- Motor de cálculo y promociones (`pricing.test.ts`).
- Contratos de selección de combos configurables (`combos.test.ts`).
- Deduplicación, ordenamiento por prioridad y ciclo de vida del Outbox (`performance_features.test.ts`).
- Invariantes de jornadas laborales abiertas, cerradas y auto-cierre de fechas anteriores (`performance_features.test.ts`).
- Pérdida de confirmaciones HTTP, protección de cambios pendientes, rollback del outbox y jornadas históricas offline (`sync_integrity_sqlite.test.ts`).
- Respaldos, restauración transaccional, reintentos y retención del outbox (`local_backup_outbox.test.ts`).

Las pruebas que usan SQLite real requieren Node.js 24. En versiones sin `node:sqlite` se omiten esos casos; para una verificación completa utiliza Node.js 24.

#### Comprobación del catálogo al confirmar una preventa

Con conexión, la app consulta `POST /api/orders/validate` antes de guardar para comprobar el cliente, los productos, las presentaciones y las opciones del carrito. Si otro dispositivo eliminó alguno, bloquea el alta y permite corregir el carrito. Si cambiaron nombres, presentaciones o precios, muestra una revisión; el vendedor puede conservar los precios del pedido o usar los actuales, revisar el total y confirmar de nuevo. La comprobación vuelve a ejecutarse en esa confirmación.

La consulta tiene un límite de 8 segundos. Sin conexión se mantiene el guardado offline con un aviso de verificación pendiente. Si el teléfono aparenta tener conexión pero falla la comprobación, se pide elegir entre volver a revisar o guardar sin verificar. Los errores de sesión no se tratan como modo offline. La consulta no abre ni cierra jornadas; la recuperación de capturas offline de jornadas cerradas conserva su regla actual.

#### Detalle de pendientes de sincronización

En **Inicio → Ver cambios pendientes** puedes consultar todos los cambios aún no confirmados, incluidos los errores permanentes. Los contadores muestran el total completo, aunque haya más de cinco errores. **Por revisar** filtra errores de envío y validaciones que requieren corrección; los reintentos programados se muestran en **Todos**, junto con su motivo y la fecha desde la que se pueden reintentar.

Cada cambio identifica su preventa, cliente, producto o categoría y permite abrir el registro disponible. Las preventas se abren en detalle para conservar las restricciones de jornadas cerradas y anulaciones. Los registros ausentes o dados de baja siguen visibles, sin ofrecer su editor. La lista funciona sin conexión, carga páginas de 30 cambios y se actualiza al volver de una edición o terminar una sincronización. Un mismo registro puede tener varios cambios pendientes.

#### Precios compartidos y mediciones de rendimiento

El móvil y el servidor utilizan el mismo núcleo de cálculo en `backend/src/shared/pricing-core.ts`: reparto de centavos, subtotales, impuestos y totales. Los adaptadores conservan los precios históricos de cada preventa. Para compilar el móvil conserva también esa carpeta del repositorio; Metro está configurado para incluirla.

En **Mi cuenta → Mediciones de rendimiento** puedes consultar los tiempos de comprobación del catálogo, guardado, esperas de escritura y sincronización en este teléfono. Se muestran la última duración, la media, la máxima y los fallos. Repite la misma tarea varias veces y pulsa **Actualizar mediciones** para comparar. Son agregados de la sesión actual: se pierden al cerrar por completo la app, no contienen datos de pedidos y no se envían al servidor. **Borrar mediciones** solo reinicia estos contadores.

#### Respaldos y mantenimiento local

En **Mi cuenta → Guardar respaldo** se crea una copia de los datos de trabajo, incluidas las preventas y operaciones pendientes. Puedes guardarla en una carpeta de Android para conservarla después de reinstalar la app. No incluye contraseñas ni tokens.

En **Mi cuenta → Restaurar respaldo** puedes elegir una copia local o importar las copias de una carpeta. La app valida el archivo, respalda los datos actuales y restaura todo en una transacción. Los cambios pendientes restaurados se procesan en la próxima sincronización.

La lista utiliza un índice pequeño para evitar abrir todos los respaldos completos. Los respaldos antiguos reconstruyen ese índice automáticamente. Puedes usar **Eliminar copia local** para depurar archivos; si una copia contiene cambios pendientes, primero debes usar **Guardar en carpeta**. La exportación verifica el archivo externo antes de habilitar su eliminación local. No se eliminan respaldos automáticamente.

**Reiniciar datos locales** y **Descartar pendientes con error** guardan un respaldo antes de actuar. Si el respaldo falla, no se ejecuta la operación. Antes de reiniciar una copia con cambios pendientes, guarda también el archivo en una carpeta externa si necesitas conservarlo fuera de la app.

El mantenimiento automático solo elimina eventos `done` del outbox cuya confirmación tenga más de 30 días. Conserva pedidos, clientes, jornadas y eventos pendientes o con error. Los errores temporales se reintentan sin límite de intentos, con esperas de 30 segundos a 15 minutos; las validaciones permanentes requieren corrección o descarte explícito.

#### e. Generar un APK para instalación directa

El perfil `preview` de `mobile/eas.json` genera un APK firmado para instalar directamente en teléfonos Android. Antes de crear una actualización, incrementa `android.versionCode` en `mobile/app.json`.

```bash
cd mobile
eas login
eas build --platform android --profile preview
```

El progreso, el enlace de descarga y el código QR aparecen en Expo.dev. El perfil `production` genera un archivo AAB destinado a Google Play.

---

## Despliegue del backend en EC2

La API instalada está en **https://18.227.163.204/api**. Backend, PostgreSQL y reportes se ejecutan en EC2; Nginx ofrece HTTPS y el servicio `preventapro` se inicia con systemd. La configuración de producción está en `/etc/preventapro/backend.env`, reservada a root. La base usa el socket local de PostgreSQL y el puerto 5432 no está expuesto a Internet.

Los scripts y el estado están en [deploy/ec2/README.md](deploy/ec2/README.md) y [deploy/ec2/ESTADO.md](deploy/ec2/ESTADO.md). Las copias diarias se guardan en S3 y se han comprobado con restauraciones en bases temporales.

Para comprobar las rutas de lectura y la validación de un borrador, ejecuta `npm run verify:ec2` desde `backend`. Usa SSH y la configuración privada del servidor; el PC no necesita las credenciales de producción. No crea pedidos ni cambia el catálogo.

El APK 1.0.3 (4) ya apunta a EC2. Actualizar el backend manteniendo esa URL no requiere otro APK. Los servicios anteriores de Render y Neon ya no forman parte de la arquitectura de la aplicación.

---

## 🔒 Seguridad y Buenas Prácticas

- **Contraseñas seguras:** Almacenadas mediante el algoritmo nativo `scrypt` con salt individual por usuario.
- **Tokens JWT:** Validación de autenticación en todas las rutas de mutación (`catalog`, `clients`, `orders`, `settings`, `sync`).
- **Prevención de doble envío:** Formularios protegidos con referencias `isSubmittingRef` contra doble toque rápido en pantallas de venta, cliente y producto.
- **Protección contra DoS:** Tamaño de payload JSON acotado explícitamente a 10 MB para soportar sincronizaciones masivas de preventas sin comprometer la memoria del servidor.

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
       │                              [PostgreSQL (Neon)]
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

- Node.js (v20 o superior recomendado)
- Cuenta y base de datos en [Neon PostgreSQL](https://neon.tech)
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
- `DATABASE_URL`: Cadena de conexión con SSL a PostgreSQL en Neon (`postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require`).
- `AUTH_TOKEN_SECRET`: Secreto criptográfico de al menos 32 caracteres para la firma de JWT. Puedes generar uno seguro con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- `PORT`: Puerto HTTP del servicio (por defecto `4000`).
- `SYNC_FORCE_TTL_MS`: Tiempo mínimo entre pulls forzados (opcional; por defecto `45000` ms).

#### b. Instalación y Migraciones de Base de Datos

Instala las dependencias y ejecuta el runner unificado de migraciones:

```bash
npm install
npm run migrate
```

> **Nota:** El comando `npm run migrate` es transaccional e idempotente. Crea la tabla de control `_migrations` y aplica en orden:
> 1. Esquema base (`pg.ts`): tablas `users`, `categories`, `clients`, `products`, `orders`, `order_items`, etc.
> 2. Autenticación (`migrate-auth.ts`): columnas de contraseñas scrypt.
> 3. Combos y promociones (`migrate-combos.ts`): `combo_definitions` y `combo_options`.
> 4. Depuración de stock (`migrate-remove-stock.ts`): retiro definitivo de inventario obsoleto.
> Se puede ejecutar múltiples veces seguidas de manera completamente segura.

#### c. Configuración de Contraseñas de Preventistas

Asigna la contraseña a las cuentas registradas en Neon:

```bash
npm run user:set-password -- PV001
npm run user:set-password -- PV002
```

*(Reemplaza `PV001` y `PV002` por los códigos reales de tus usuarios).*

#### d. Iniciar en Desarrollo

```bash
npm run dev
```

La API estará escuchando en `http://localhost:4000/api`.

#### e. Ejecutar Pruebas del Backend

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

---

## 🔒 Seguridad y Buenas Prácticas

- **Contraseñas seguras:** Almacenadas mediante el algoritmo nativo `scrypt` con salt individual por usuario.
- **Tokens JWT:** Validación de autenticación en todas las rutas de mutación (`catalog`, `clients`, `orders`, `settings`, `sync`).
- **Prevención de doble envío:** Formularios protegidos con referencias `isSubmittingRef` contra doble toque rápido en pantallas de venta, cliente y producto.
- **Protección contra DoS:** Tamaño de payload JSON acotado explícitamente a 10 MB para soportar sincronizaciones masivas de preventas sin comprometer la memoria del servidor.

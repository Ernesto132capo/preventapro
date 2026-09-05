# PreventaPro — Aplicación móvil de preventas/DSD

Proyecto real (no prototipo): backend Node/Express funcional con base de datos,
autenticación, cálculo de precios centralizado, jornadas, sincronización y reportes
Excel reales; app móvil Expo/React Native con capa offline-first (SQLite local +
cola de sincronización) sobre la misma lógica de negocio.

## Estructura

```
preventapro/
  backend/   API REST (Node + Express + TypeScript + SQLite)
  mobile/    App móvil (Expo + React Native + TypeScript)
  docs/      Este roadmap
```

## Cómo correrlo

### 1. Backend

```bash
cd backend
npm install
npm run migrate     # crea el esquema SQLite
npm run seed         # usuario demo + cliente + producto de ejemplo
npm run dev           # http://localhost:4000
```

Usuario demo: **código `PV001`**, **contraseña `preventa123`**.

Prueba rápida:
```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"PV001","password":"preventa123"}'
```

Correr los tests del módulo de precios:
```bash
npm test
```

### 2. App móvil

```bash
cd mobile
npm install
```

Antes de arrancar, edita `src/services/config.ts` (o define `EXPO_PUBLIC_API_URL`)
con la IP de tu computadora en la red local — **no** `localhost`, porque el teléfono
no puede resolverlo. Ejemplo: `http://192.168.1.50:4000/api`.

```bash
npx expo start
```

Escanea el QR con la app **Expo Go** (Android/iOS) o corre en un emulador.

Correr los tests del módulo de dominio (misma lógica de precios que el backend):
```bash
npm test
```

## Qué está REALMENTE implementado y probado

- **Backend**: auth (bcrypt+JWT), clientes (CRUD + alta rápida + soft delete),
  catálogo (productos con presentaciones múltiples configurables + stock por
  presentación), preventas (cálculo centralizado, snapshot inmutable, transacciones
  atómicas, idempotencia real — probado creando la misma preventa dos veces),
  jornadas (apertura automática, cierre con validación exacta de `CONFIRMAR`,
  bloqueo tras cierre), reportes Excel reales generados con datos verdaderos
  (`lista_de_productos.xlsx`, `resumen_clientes.xlsx`). 7/7 tests unitarios.
- **Móvil**: SQLite local con el mismo modelo de datos, motor de sincronización
  (patrón outbox: cola genérica, prioridad clientes/productos antes que preventas,
  reintentos con backoff simple, resolución de dependencias local→servidor),
  flujo completo de Nueva Preventa (cliente → productos → carrito → guardar,
  100% funcional sin conexión), Preventas del día + cierre con `CONFIRMAR`,
  Clientes (lista + alta rápida + llamar/WhatsApp), Productos (catálogo + registrar
  producto), Dashboard con datos agregados reales (nunca hardcodeados), Registros
  Históricos con enlaces a los reportes. 6/6 tests del módulo de dominio, y
  TypeScript compila limpio en ambos proyectos.

## Lo que falta o quedó simplificado (léelo antes de ir a producción)

Sé honesto sobre esto para que no haya sorpresas:

1. **Escáner de código de barras**: la arquitectura está lista (el buscador de
   productos ya filtra por SKU), pero no integré la librería de cámara
   (`expo-camera` / `expo-barcode-scanner`) ni la probé en un dispositivo físico,
   porque este entorno no tiene acceso a hardware de cámara para verificarlo.
2. **Descarga de reportes desde el móvil**: el enlace actual asume que el navegador
   del dispositivo ya tiene sesión o abre el archivo directo; en producción conviene
   un endpoint de descarga con token firmado de un solo uso en vez de pasar el JWT
   por query string.
3. **Conflictos de sincronización avanzados**: implementé idempotencia (evita
   duplicados) y dependencia ordenada (clientes/productos antes que preventas),
   pero no hay una UI de resolución manual de conflictos (ej. si dos preventistas
   editan el mismo cliente casi al mismo tiempo) — hoy "gana" el último `UPDATE`.
4. **Roles y administración**: no hay panel de administración para dar de alta
   preventistas desde la app (existe el endpoint `POST /api/auth/users`, pero se usa
   por API directamente, no desde una pantalla).
5. **Pruebas end-to-end en dispositivo real**: verifiqué el backend con `curl`
   (login, catálogo, preventa, idempotencia, cierre de jornada, generación de Excel)
   y la lógica de dominio del móvil con Jest, pero no pude correr la app en un
   emulador/dispositivo real desde este entorno — no hay forma de instalar Android
   Studio ni Xcode aquí. Antes de usarla en campo, corre `npx expo start` en tu
   máquina y prueba el flujo completo tú mismo.
6. **Promociones con fechas**: el modelo de datos soporta `promo_active`,
   `promo_price_cents`, `promo_starts_at/ends_at`, pero no implementé la lógica de
   activación automática por fecha (se marca manualmente por ahora).
7. **Multiidioma/moneda**: fijo en BOB/Bs. como pediste; cambiarlo es sencillo pero
   no está parametrizado.

## Siguientes pasos sugeridos

1. Corre ambos proyectos en tu máquina y prueba el flujo real en tu teléfono con Expo Go.
2. Ajusta la paleta/tipografía fina si notas diferencias con Figma (usé los valores
   exactos que pude extraer vía la API de Figma, pero no hice un pixel-diff pantalla
   por pantalla).
3. Cuando quieras pasar a producción: cambia SQLite del backend por Postgres (el
   código usa SQL estándar, la migración es directa), despliega el backend con
   HTTPS, y genera un build de Expo (`eas build`) para las tiendas.
4. Dime qué pantalla o flujo quieres que revise/ajuste primero y seguimos iterando.

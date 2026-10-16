# PreventaPro

Aplicación móvil para que dos preventistas registren preventas en ruta, incluso cuando no tienen conexión. La app conserva los cambios en SQLite y los sincroniza con el backend cuando vuelve Internet.

## Componentes

- `mobile/`: Expo, React Native y TypeScript. Incluye clientes, catálogo, combos, carrito de preventa, jornadas e historial de reportes.
- `backend/`: API REST con Express y TypeScript. Guarda los datos compartidos en PostgreSQL de Neon y genera reportes Excel/PDF.
- Autenticación: código o correo y contraseña contra la tabla `users` de Neon. Las contraseñas se guardan con scrypt y el backend emite tokens JWT. Firebase ya no se utiliza.
- El acceso está pensado para las dos cuentas existentes de los preventistas; no hay roles ni panel de administración de usuarios.
- El precio de cada presentación se valida y calcula en el backend. Los importes se guardan en centavos.
- No se administra inventario ni stock: una preventa registra el pedido del cliente.

## Requisitos de configuración

El backend necesita una base Neon con el esquema de PreventaPro ya creado y una conexión `DATABASE_URL`. El repositorio no contiene una migración inicial completa de todas las tablas; `migrate:auth` únicamente agrega la columna para guardar los hashes de contraseña.

### Backend

1. Copia `backend/.env.example` a `backend/.env`.
2. Completa `DATABASE_URL` con la cadena de conexión de Neon y define `AUTH_TOKEN_SECRET` con un secreto aleatorio de al menos 32 caracteres. Puedes generar uno con:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

3. Instala dependencias y prepara la columna de contraseña:

   ```bash
   cd backend
   npm ci
   npm run migrate:auth
   ```

4. Asigna una contraseña a cada cuenta existente en Neon. El comando solicita la contraseña sin mostrarla en pantalla:

   ```bash
   npm run user:set-password -- PV001
   npm run user:set-password -- PV002
   ```

   Reemplaza `PV001` y `PV002` por los códigos reales de las cuentas en la tabla `users`. Cada preventista tendrá que iniciar sesión una vez con su nueva contraseña; las contraseñas de Firebase no se pueden recuperar ni migrar.

5. Inicia la API:

   ```bash
   npm run dev
   ```

La API queda disponible en `http://localhost:4000/api`. El inicio de sesión es `POST /api/auth/login` con `identifier` y `password`; `identifier` acepta el código de preventista o el correo real guardado en Neon.

Para retirar también la columna antigua de stock en Neon, ejecuta una sola vez `npm run migrate:remove-stock`. No es necesaria para que la nueva versión funcione: el backend ya no lee ni escribe esa columna.

### Aplicación móvil

1. Copia `mobile/.env.example` a `mobile/.env`.
2. En `EXPO_PUBLIC_API_URL`, usa la dirección de tu backend. En un teléfono conectado a la misma red, pon la IP local de la computadora en lugar de `localhost`; para el backend desplegado, usa su URL HTTPS.
3. Inicia Expo:

   ```bash
   cd mobile
   npm ci
   npx expo start
   ```

En EAS, configura `EXPO_PUBLIC_API_URL` en el entorno del perfil de build para que el APK de pruebas apunte al backend que quieras probar. Si no se define, la app usa el backend desplegado configurado como valor predeterminado.

## Uso en campo

1. Inicia sesión con el código o correo y contraseña de uno de los preventistas.
2. Selecciona un cliente, agrega productos y presentaciones al carrito y guarda la preventa.
3. Sin conexión, los cambios quedan en el teléfono y aparecen como pendientes; se sincronizan cuando vuelve la red.
4. En **Registros** puedes consultar jornadas cerradas y descargar sus reportes.

## Cambios frente a versiones anteriores

- Firebase Authentication y Firebase Admin fueron retirados. Las cuentas usan contraseñas guardadas como hashes en Neon.
- El stock fue retirado de productos, presentaciones, formularios, API y sincronización. La migración local de SQLite elimina la columna antigua cuando el motor lo permite.
- Las credenciales y URLs se configuran mediante archivos `.env`; no guardes esos archivos con valores reales en Git.

## Funciones pendientes

- No hay escáner de código de barras; se puede buscar por nombre o SKU.
- La activación automática de promociones por fecha no está implementada.
- No se ha validado el flujo completo en un dispositivo físico en esta versión.

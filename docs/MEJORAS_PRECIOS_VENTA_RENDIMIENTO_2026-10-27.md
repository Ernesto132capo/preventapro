# Precios compartidos, pantalla de venta y mediciones locales

Cambios del 27 de octubre de 2026, posteriores al detalle de pendientes de sincronización.

## Un único cálculo monetario

`backend/src/shared/pricing-core.ts` concentra `PricingError`, reparto proporcional de centavos, validación de subtotales, redondeo de impuestos, agregación de totales y formato monetario. Tanto `mobile/src/domain/pricing.ts` como `backend/src/services/pricing.ts` utilizan este núcleo. Los adaptadores conservan la construcción de sus snapshots y el respeto de precios históricos.

El núcleo vive dentro del backend para mantener su compilación y despliegue desde la carpeta `backend`. Metro observa únicamente esa carpeta compartida adicional y resuelve los auxiliares de Babel desde las dependencias del móvil. Una compilación móvil necesita el checkout del repositorio con `backend/src/shared` presente. No se añadieron dependencias.

Las pruebas de paridad contrastan ambos adaptadores con importes y redondeos esperados, precios históricos, alias, líneas inválidas, límites de enteros y reparto exacto de combos.

## Responsabilidades de la pantalla de venta

`NewSaleScreen.tsx` pasa de 1.486 a 915 líneas:

- `components/sale/SaleRows.tsx`: filas de clientes, productos y carrito.
- `components/sale/SaleDialogs.tsx`: revisión del carrito, comparación de precios y confirmación final.
- `hooks/useSaleCatalog.ts`: búsquedas, filtros, categorías, favoritos y productos recientes/frecuentes.

La carga del catálogo ignora respuestas de filtros anteriores o lecturas que terminan tras salir de la pantalla. Se muestran estados de carga y errores de lectura. Las comprobaciones de borrador, consentimiento offline, cambios de catálogo, jornadas cerradas, precios históricos y bloqueo de doble guardado conservan su flujo.

## Mediciones locales

Acceso: **Inicio → Mi cuenta → Mediciones de rendimiento**. No hay que configurar un servicio externo.

Se miden por separado comprobación del catálogo, escritura de la preventa, preparación del almacenamiento, espera de transacciones, ejecución de transacciones, espera de sincronización, sync completo, envío, recepción y procesamiento de pendientes. La medición de guardado local excluye la comprobación remota, los diálogos y el envío en segundo plano. Las llamadas concurrentes que comparten una sincronización registran una sola ejecución real.

Se conservan únicamente diez categorías fijas con conteos, fallos, última duración, suma, máximo y fecha de la última muestra. No se guardan IDs, nombres, importes, credenciales, payloads ni mensajes de error. No se escriben archivos ni se transmiten métricas. Los contadores desaparecen al terminar el proceso de la app; borrarlos no modifica SQLite y descarta muestras antiguas que aún estaban en vuelo.

Para medir en un teléfono:

1. Abre las mediciones y borra los contadores si quieres comenzar una comparación nueva.
2. Guarda varias preventas con una carga parecida. Repite con conexión y sin ella para separar guardado local de comprobación remota.
3. Sincroniza y vuelve a la pantalla de mediciones. Usa **Actualizar mediciones**.
4. Compara duración media y máxima de guardado, espera y sincronización. Las etapas pueden solaparse o estar incluidas unas en otras: no se deben sumar como si fueran tiempos independientes.

Estos cambios permiten diagnosticar lentitudes; no constituyen una medición de mejora porcentual ni un benchmark de un teléfono real.

## Verificación

- Móvil: **20 suites y 326 pruebas correctas**, con SQLite real para sincronización e integridad.
- Servidor: **13 suites y 217 pruebas correctas**, incluidos reportes reales Excel/PDF y reglas monetarias.
- TypeScript móvil y compilación del servidor correctos.
- Exportación Android con bytecode Hermes correcta: 822 módulos, incluido el núcleo compartido. Resultado local en `mobile/.expo/improvements-export`; no es un APK instalable.
- Los temporales de las pruebas de archivos se ubicaron dentro de `backend/dist/test-tmp` para evitar restricciones de escritura de Windows.
- La comprobación en un teléfono sigue siendo necesaria para evaluar interacción y duraciones reales.

# Validación del catálogo antes de guardar una preventa

Se corrigió el caso de un teléfono con copia local antigua que permitía crear una preventa con un cliente eliminado desde otro dispositivo y mostraba el conflicto recién al sincronizar.

## Comportamiento

- Con conexión, el móvil consulta el cliente y las líneas del carrito antes de escribir el nuevo pedido en SQLite. El endpoint autenticado `POST /api/orders/validate` responde con disponibilidad, problemas y metadatos actuales; no guarda pedidos ni consulta, abre o cierra jornadas.
- Un cliente eliminado impide crear una preventa nueva y devuelve la pantalla a elegir cliente, conservando los productos del carrito.
- Productos, presentaciones y opciones de combos eliminados o inválidos impiden guardar. El vendedor puede retirar las líneas afectadas o actualizar el catálogo y volver a elegirlas.
- Los cambios relevantes de nombres, presentaciones, equivalencias o precios requieren una revisión. Se muestran los totales anterior y actual cuando cambian precios. Se pueden mantener precios del pedido o adoptar los actuales; después se vuelve a confirmar y consultar. Una aprobación anterior no autoriza cambios nuevos del servidor.
- Al agregar un combo o cargar una edición se captura su configuración. Los cambios de mínimos, máximos, opciones o límites también avisan aunque la selección siga siendo válida. La comparación normaliza IDs locales/remotos y no añade columnas a SQLite.
- La elección histórica ya hecha al abrir una edición se conserva si el precio actual del catálogo no volvió a cambiar. La edición de una preventa ya existente mantiene su cliente histórico aunque este se haya desactivado; no permite cambiar esa asociación.
- Entidades nuevas creadas localmente aún sin ID remoto se reconocen como pendientes de publicación. No se confunden con registros conocidos desactivados. Se resuelven IDs locales/remotos de padres y opciones.
- En modo offline el guardado sigue disponible y se informa de la comprobación pendiente. No es posible conocer una baja remota sin comunicación con el servidor. Si una conexión aparente falla, la app pide consentimiento antes de guardar sin verificar. Los errores de autenticación siguen bloqueando el guardado online.
- La consulta dura como máximo 8 segundos. El push posterior sigue ejecutándose en segundo plano, sin retrasar la confirmación local.
- Si el usuario modifica el carrito o abandona la pantalla mientras se consulta, una respuesta antigua no guarda el borrador anterior. Se conserva la protección contra doble toque.
- SQLite revalida dentro de la transacción la existencia/actividad local de cliente, productos, presentaciones y componentes. Rechazar el pedido no deja cabeceras ni eventos outbox parciales. Las preventas offline que ya existían no se borran ni se reescriben.

## Compatibilidad y validación

No cambió la política que permite recuperar altas capturadas offline en una jornada cerrada. No se añadieron tablas ni migraciones, ni se modificaron tokens, endpoints existentes de escritura o nombres de reportes.

- Backend: 217/217 pruebas, incluidas disponibilidad, aislamiento de lectura, autenticación, altas pendientes y asociación de opciones de combo.
- Móvil: 278/278 pruebas, incluidas SQLite real, cliente eliminado en otro dispositivo, producto no disponible, revisión de precios y combos, elecciones históricas, errores de red, desmontaje y respuestas de borradores anteriores.
- TypeScript sin errores en ambos paquetes.
- Las consultas de PostgreSQL y HTTP se simulan en las pruebas; el móvil utiliza SQLite real con Node.js 24. No se realizó una prueba táctil con dos teléfonos físicos.

Esta corrección requiere desplegar el backend actualizado para que el endpoint de comprobación esté disponible. Con un backend anterior la app avisa que la comprobación no está disponible y permite elegir si guardar sin verificar. No se ejecutó ningún despliegue ni se generó un APK en esta tarea.

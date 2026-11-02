# Preparación de EC2 para PreventaPro

Estos archivos preparan Ubuntu 24.04, despliegan el backend y permiten una migración controlada con respaldo y comparación de datos. No contienen contraseñas; los scripts de migración requieren las credenciales existentes por entrada segura y rechazan sobrescribir la base de destino.

- `prepare-host.py`: usuario de servicio sin acceso interactivo, estructura de carpetas, 1 GiB de swap, límites de journald, actualizaciones de NodeSource 24 y servicios/timers.
- `enable-https.py`: Nginx delante de `127.0.0.1:4000`, HTTPS para la IP elástica y recarga tras renovar el certificado. El acceso HTTP redirige a HTTPS salvo la validación ACME.
- `ops.py`: comprobaciones de salud, copias `pg_dump` validadas y subida a S3, informe semanal de vulnerabilidades de dependencias. No modifica dependencias automáticamente.
- `verify-backup.py`: crea datos sintéticos, ejecuta una copia y restaura en otra base temporal; con `--s3` comprueba también descarga e integridad SHA-256.
- `install-postgres18.py`: instala PostgreSQL 18 desde el repositorio oficial y solo toma el puerto 5432 si el clúster anterior no contiene bases/tablas de aplicación. Conserva el clúster anterior detenido.
- `transfer-backend.py` / `install-backend.py`: instalación inicial mediante un paquete de código sin secretos y con verificación SHA-256. El instalador conserva la versión preparada y se detiene si ya existe un backend instalado; no sobrescribe una instalación en uso.
- `run-migration.cjs` / `migrate-neon.cjs`: herramientas históricas de la importación inicial. Exigen `--source-env` explícito; ya no leen la configuración de desarrollo. Rechazan sobrescribir la base de destino. Las credenciales viajan por stdin cifrado de SSH y no se imprimen ni se pasan como argumentos.
- `create-dev-database.py`: crea una base de desarrollo independiente y un usuario sin privilegios de administración; recibe su contraseña por stdin y limita sus conexiones a esa base por localhost. Se ejecutó una vez; rechaza reemplazar una base existente.
- `verify-deployment.cjs` / `verify-api.cjs`: comprueban por HTTPS las rutas de lectura y la validación de un borrador. Se ejecutan mediante SSH en EC2, usando la configuración privada del servidor y después la identidad del servicio. No requieren Neon ni credenciales de producción en el PC y no registran datos de clientes.
- `validate-workday.py`: ejecuta una jornada sintética en una base separada y guarda su resultado.
- `verify-database-backup.py`: descarga de S3 un respaldo de la aplicación, lo restaura en una base temporal, compara las tablas y activa las copias diarias tras el éxito.
- `wait-for-apk.cjs`: consulta un build de Expo ya solicitado, descarga su APK y comprueba firma, versión y URL de EC2. No solicita builds nuevos ni cambia el plan de Expo. Su estado y destino de descarga se indican por argumentos; el seguimiento actual figura en `ESTADO.md`.
- `aws-infrastructure.json`: plantilla CloudFormation con bucket privado, cifrado y retención de 30 días, SNS, tres alarmas EC2, aviso de gasto mensual y rol de instancia limitado a respaldos y avisos. El correo se entrega como parámetro al crear la pila.

La instancia actual se preparó mediante la consola y los scripts, sin desplegar esa pila CloudFormation. No aplicar la plantilla sobre los recursos existentes: sus nombres ya están en uso. Consultar `ESTADO.md` antes de continuar.

## Activación del backend

El servicio `preventapro.service` espera `/opt/preventapro/backend/dist/index.js` y `/etc/preventapro/backend.env`. Mientras falten, systemd lo omite y no intenta iniciar una aplicación incompleta. El usuario `preventapro` no tiene sudo ni shell interactiva. Solo puede escribir en su carpeta de reportes, estado y caché.

Antes de importar datos hay que comprobar la versión del servidor de origen y elegir una versión compatible de PostgreSQL y de `pg_dump`. La instalación inicial de Ubuntu incluía PostgreSQL 16; la migración actual usa PostgreSQL 18.6 en ambos extremos.

## Desarrollo desde el PC

`backend/.env` usa `preventapro_dev` por el puerto local 55432, con contraseña propia. `npm run db:tunnel` mantiene un túnel SSH que solo escucha en localhost y exige la clave y la huella del servidor verificadas. `npm run dev` se ejecuta en otra terminal. Las credenciales y rutas privadas no se incluyen en Git. El usuario de desarrollo tiene bloqueado el acceso a `preventapro`; la base de los teléfonos conserva sus propias cuentas y sesiones.

Desde `backend`, `npm run verify:ec2` verifica la API pública usando SSH. El APK instalado sigue apuntando a la misma dirección de EC2 y no requiere recompilarse por estos cambios del backend.

## Respaldos

La configuración está en `/etc/preventapro/ops.json` (root, modo 0600). El timer diario es a las 06:00 UTC, con un margen aleatorio de cinco minutos. Se activa creando `/etc/preventapro/backup.enabled` **después de una copia real correcta de la base de la aplicación**.

Los archivos locales pertenecen a root, modo 0600. Se conservan siete días de copias subidas correctamente. Los objetos S3 se conservan 30 días; las versiones anteriores, siete días. El rol no permite borrar objetos ni acceder a otros buckets. El manifiesto guarda SHA-256, tamaño y fecha; tras subir se comprueban tamaño y metadatos con `HeadObject`.

`/healthz` comprueba únicamente Nginx y HTTPS. `/api/health` corresponde a la aplicación, ya desplegada en esta instancia. Las alertas del backend solo se activan cuando existen el código y su configuración; las de respaldo, cuando se activa su marcador.

## Operación

```sh
systemctl status preventapro nginx postgresql
systemctl list-timers 'preventapro-*'
journalctl -u preventapro -n 100 --no-pager
sudo python3 /usr/local/lib/preventapro-ops/ops.py health
sudo python3 /usr/local/lib/preventapro-ops/ops.py backup
sudo /snap/bin/certbot renew --dry-run
```

Los logs de acceso de Nginx omiten los parámetros de las URL para evitar guardar tokens de descarga. Los scripts no incluyen información de clientes/pedidos en las notificaciones. La suscripción SNS requiere que el destinatario confirme el correo de AWS.

AWS Budgets tiene una verificación de correo independiente de SNS. El presupuesto de 30 USD solo avisa: no detiene recursos ni establece un límite de cobro. Excluye créditos y reembolsos para medir consumo antes de los créditos promocionales.

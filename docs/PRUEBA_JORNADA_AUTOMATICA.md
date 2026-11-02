# Simular una jornada en EC2

La aplicación ya usa PostgreSQL y el backend en EC2. Esta prueba no requiere Neon ni Render.

## Comprobación breve del volumen de trabajo

Desde una sesión SSH de la EC2:

```sh
sudo python3 /usr/local/lib/preventapro-ops/validate-workday.py
```

El script crea una base nueva cuyo nombre empieza por `preventapro_simulation_`, copia el backend a una carpeta separada y utiliza dos usuarios ficticios. Recorre 100 preventas, combos, ediciones, cancelaciones, reintentos idempotentes, recuperación de una cola offline, cierre y reportes. No modifica la base `preventapro` de los teléfonos ni `preventapro_dev`.

La ejecución comprime el calendario a 0,1 minutos. Sirve para comprobar el flujo y el volumen; **no representa cinco horas reales de CPU, consumo del teléfono ni facturación mensual**. También consume recursos brevemente en la EC2 y conserva la base y los resultados de prueba para su revisión.

El resultado consolidado está en `/var/lib/preventapro-ops/workday-validation.json`. El programa imprime además la carpeta que contiene `summary.json`, `requests.csv` y el informe de la ejecución. No registra contraseñas ni tokens. Solo se deben usar resultados marcados como completados.

## Vista previa desde el PC

Desde `backend`:

```sh
npm run simulate:day
```

Solo muestra el plan; no conecta a una base ni crea pedidos.

## Ejecuciones personalizadas

El simulador `scripts/simulate-day.mjs` admite `--run --real` para distribuir la carga durante cinco horas, además de `--orders`, `--lines`, `--products`, `--clients` y `--days`. Requiere una base de pruebas nueva y vacía, y una configuración `.env.simulation` explícita. La plantilla es `.env.simulation.example`.

La base debe ser independiente del destino habitual y de producción. El simulador bloquea endpoints coincidentes con la conexión habitual y bases con tablas previas. No sustituir esos controles ni pegar la conexión de `preventapro` o `preventapro_dev` para hacer una prueba.

La ejecución de EC2 anterior prepara automáticamente su propio entorno aislado y es la forma utilizada para la verificación breve de esta migración. Para una ejecución larga, preparar un entorno aislado equivalente y ajustar la duración; no ejecutar el simulador directamente desde la carpeta de producción con su configuración.

Si se usa un servidor HTTP de pruebas externo, `SIMULATION_API_URL` debe usar HTTPS y su nombre debe identificarlo como pruebas. Tiene que apuntar a una base vacía exclusiva de la ejecución. La API pública de los teléfonos no se utiliza como destino del simulador.

## Cómo interpretar los resultados

Los bytes del informe son cuerpos HTTP vistos por el cliente. No incluyen necesariamente cabeceras, TLS, consultas SQL ni compresión; no equivalen al importe facturado por AWS. El espacio físico de PostgreSQL incluye índices y páginas que pueden crecer por saltos.

Para estimar un mes, observar una jornada real en CloudWatch y el consumo de la cuenta, separando la preparación inicial. Una simulación acelerada no permite extrapolar directamente horas de CPU. Las pruebas de interfaz, SQLite y recuperación de red en los teléfonos siguen siendo necesarias.

## Comprobaciones del simulador

```sh
npm run test:simulation
```

Las pruebas verifican el plan, los destinos protegidos, los bytes y el flujo HTTP simulado. No sustituyen la ejecución contra PostgreSQL ni las pruebas físicas.

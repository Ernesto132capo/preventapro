import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import dotenv from 'dotenv';
import { makePlan, makeMeteredRequest, runWorkload, summarize } from './simulation/workload.mjs';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function endpointIdentity(value) {
  const url = new URL(value);
  // Neon usa el mismo endpoint con y sin el sufijo de conexión agrupada.
  return url.hostname.toLowerCase().replace(/-pooler(?=\.)/, '').replace(/^localhost$/, '127.0.0.1');
}

export function assertSafeDatabase(target, productionUrls) {
  const url = new URL(target);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Configura una conexión PostgreSQL de prueba.');
  if (productionUrls.some((value) => value && endpointIdentity(value) === endpointIdentity(target))) {
    throw new Error('Bloqueado: el destino comparte el endpoint de la base habitual. Crea un proyecto de pruebas separado.');
  }
  const local = ['127.0.0.1', '[::1]'].includes(endpointIdentity(target));
  if (local && !decodeURIComponent(url.pathname).includes('simulation')) throw new Error('La base local debe incluir simulation en su nombre.');
  if (url.searchParams.has('options')) throw new Error('La conexión de prueba no debe traer options; el simulador configura su propio esquema.');
  return url;
}

export function assertSafeApi(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/\b(simulation|simulacion|pruebas|test)\b/i.test(url.hostname)) {
    throw new Error('El servidor externo debe usar HTTPS y tener simulation, simulacion, pruebas o test en su nombre.');
  }
  if (url.hostname === 'preventapro-backend.onrender.com' || !['', '/', '/api', '/api/'].includes(url.pathname)) throw new Error('Servidor de prueba inválido. No uses la URL real.');
  url.pathname = '/api';
  return url.toString();
}

function numberOption(args, name, fallback, min, max) {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: valor entre ${min} y ${max}.`);
  return value;
}

async function runCommand(args, env, log) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: backend, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => log.push(chunk.toString()));
    child.stderr.on('data', (chunk) => log.push(chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Falló la preparación del backend. Revisa setup.log.')));
  });
}

function withSchema(connection, schema) {
  const url = new URL(connection);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  return url.toString();
}

export async function ensureEmptyTestDatabase(pool) {
  const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  if (rows.some((row) => row.tablename !== '_preventapro_simulation')) {
    throw new Error('Bloqueado: hay tablas previas en public. Usa una base de pruebas vacía, sin copiar ventas reales.');
  }
  await pool.query('CREATE TABLE IF NOT EXISTS public._preventapro_simulation (purpose text NOT NULL)');
  const marker = await pool.query('SELECT purpose FROM public._preventapro_simulation');
  if (!marker.rows.length) await pool.query("INSERT INTO public._preventapro_simulation VALUES ('synthetic-workday-v1')");
  else if (marker.rows.length !== 1 || marker.rows[0].purpose !== 'synthetic-workday-v1') throw new Error('La base no tiene una marca de simulación válida.');
}

export function assertSameWorkDate(minutes, now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' });
  // Reserva quince minutos para preparar el catálogo, cerrar y descargar reportes.
  if (formatter.format(now) !== formatter.format(now + (minutes + 15) * 60_000)) {
    throw new Error('La prueba cruzaría medianoche en Bolivia y el backend cerraría la jornada. Iníciala más temprano o usa el modo corto.');
  }
}

async function seed(pool, { products, clients }) {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  const key = await promisify(scrypt)(password, salt, 64);
  const passwordHash = `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
  const fixture = { users: [], products: [], clients: [], combo: null };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < 2; index++) {
      const user = { id: randomUUID(), code: `simulation-${index + 1}-${randomBytes(6).toString('hex')}` };
      await client.query('INSERT INTO users (id, code, full_name, password_hash) VALUES ($1,$2,$3,$4)', [user.id, user.code, `Teléfono simulado ${index + 1}`, passwordHash]);
      fixture.users.push(user);
    }
    const category = randomUUID();
    await client.query('INSERT INTO categories (id,name) VALUES ($1,$2)', [category, 'Catálogo ficticio de pruebas']);
    for (let index = 0; index < products; index++) {
      const product = { id: randomUUID(), presentationId: randomUUID(), priceCents: 500 + index * 10 };
      await client.query('INSERT INTO products (id,sku,name,category_id,created_by) VALUES ($1,$2,$3,$4,$5)', [product.id, `SIM-${index}`, `Producto ficticio ${index + 1}`, category, fixture.users[0].id]);
      await client.query('INSERT INTO product_presentations (id,product_id,name,price_cents) VALUES ($1,$2,$3,$4)', [product.presentationId, product.id, 'Unidad', product.priceCents]);
      fixture.products.push(product);
    }
    const combo = { id: randomUUID(), presentationId: randomUUID(), priceCents: 900 };
    await client.query("INSERT INTO products (id,sku,name,category_id,product_type) VALUES ($1,'SIM-COMBO','Combo ficticio',$2,'combo')", [combo.id, category]);
    await client.query("INSERT INTO product_presentations (id,product_id,name,price_cents) VALUES ($1,$2,'Combo',$3)", [combo.presentationId, combo.id, combo.priceCents]);
    const definition = randomUUID();
    await client.query('INSERT INTO combo_definitions (id,product_id,selection_min,selection_max) VALUES ($1,$2,2,2)', [definition, combo.id]);
    for (const product of fixture.products.slice(0, 2)) await client.query('INSERT INTO combo_options (id,combo_id,presentation_id,max_quantity) VALUES ($1,$2,$3,2)', [randomUUID(), definition, product.presentationId]);
    fixture.combo = combo;
    for (let index = 0; index < clients; index++) {
      const id = randomUUID();
      await client.query('INSERT INTO clients (id,client_local_id,business_name,name,created_by) VALUES ($1,$1,$2,$2,$3)', [id, `Tienda ficticia ${index + 1}`, fixture.users[index % 2].id]);
      fixture.clients.push(id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  return { fixture, password };
}

async function storage(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT COALESCE(SUM(pg_total_relation_size(c.oid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema() AND c.relkind IN ('r','m')) AS allocated_bytes,
    pg_database_size(current_database())::text AS database_bytes,
    (SELECT COUNT(*)::int FROM orders) AS orders,
    (SELECT COUNT(*)::int FROM orders WHERE status='cancelled') AS cancelled,
    (SELECT COALESCE(SUM(pg_column_size(o)),0)::text FROM orders o) AS order_row_bytes,
    (SELECT COALESCE(SUM(pg_column_size(i)),0)::text FROM order_items i) AS item_row_bytes,
    (SELECT COALESCE(SUM(pg_column_size(s)),0)::text FROM order_item_selections s) AS selection_row_bytes`);
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--run', '--real', '--minutes', '--orders', '--lines', '--products', '--clients', '--days', '--help']);
  for (const arg of args.filter((item) => item.startsWith('--'))) if (!allowed.has(arg)) throw new Error(`Opción desconocida: ${arg}`);
  const plan = makePlan({ orders: numberOption(args, '--orders', 100, 10, 1000), lines: numberOption(args, '--lines', 8, 1, 50) });
  const minutes = numberOption(args, '--minutes', args.includes('--real') ? 300 : 15, 0.1, 1440);
  if (args.includes('--real') && minutes !== 300) throw new Error('--real representa cinco horas; omite --minutes.');
  const products = numberOption(args, '--products', 100, 2, 1000);
  const clients = numberOption(args, '--clients', 200, 2, 5000);
  const days = numberOption(args, '--days', 30, 1, 31);
  if (![products, clients, days].every(Number.isInteger)) throw new Error('Productos, clientes y días deben ser enteros.');
  console.log(`Plan: ${plan.orders} preventas, ${plan.lines} líneas, 2 teléfonos; ${minutes} minutos reales representan 300 minutos de trabajo.`);
  console.log(`Catálogo ficticio: ${products} productos + 1 combo; ${clients} clientes. Proyección: ${days} días.`);
  if (!args.includes('--run') || args.includes('--help')) {
    console.log('Vista previa: no se conectó ni se escribió en ninguna base. Configura backend/.env.simulation y agrega --run.');
    return;
  }
  assertSameWorkDate(minutes);
  const config = dotenv.parse(await readFile(path.join(backend, '.env.simulation')));
  if (config.SIMULATION_CONFIRM !== 'BASE_DE_PRUEBAS_VACIA') throw new Error('Configura SIMULATION_CONFIRM=BASE_DE_PRUEBAS_VACIA en .env.simulation.');
  let ordinary = {};
  try { ordinary = dotenv.parse(await readFile(path.join(backend, '.env'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = assertSafeDatabase(config.SIMULATION_DATABASE_URL, [ordinary.DATABASE_URL, process.env.DATABASE_URL]);
  const remoteBase = assertSafeApi(config.SIMULATION_API_URL);
  const ssl = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ? false : { rejectUnauthorized: true };
  const options = { connectionString: target.toString(), ssl, max: 2, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 1000 };
  // No se mantiene una conexión de medición abierta durante las cinco horas.
  let pool = new pg.Pool(options);
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
  const schema = remoteBase ? 'public' : `simulation_${runId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
  const output = path.join(backend, '.simulation', runId);
  await mkdir(output, { recursive: true });
  const log = [];
  const records = [];
  let child;
  let result = { completed: false, mode: minutes === 300 ? 'real-time' : 'accelerated', actualMinutes: minutes, runId, schema, plan: { orders: plan.orders, lines: plan.lines, products, clients, projectionDays: days } };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Prueba interrumpida.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const startedAt = new Date().toISOString();
  try {
    await ensureEmptyTestDatabase(pool);
    if (!remoteBase) await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.end();
    const connection = remoteBase ? target.toString() : withSchema(target, schema);
    pool = new pg.Pool({ ...options, connectionString: connection });
    const identity = await pool.query('SELECT current_schema() AS name');
    if (identity.rows[0].name !== schema) throw new Error('La conexión no respetó el esquema aislado. Usa la conexión Direct de tu proyecto de pruebas.');
    const env = { ...process.env, DATABASE_URL: connection, AUTH_TOKEN_SECRET: randomBytes(48).toString('base64url'), NODE_ENV: 'production', PGSSLREJECTUNAUTHORIZED: 'true', DOTENV_CONFIG_PATH: path.join(output, 'unused.env') };
    console.log('Preparando una copia del backend y un esquema aislado de esta ejecución...');
    await runCommand([path.join(backend, 'node_modules/typescript/bin/tsc'), '-p', path.join(backend, 'tsconfig.json')], env, log);
    await runCommand([path.join(backend, 'node_modules/tsx/dist/cli.mjs'), path.join(backend, 'scripts/migrate.ts')], env, log);
    const { fixture, password } = await seed(pool, { products, clients });
    const before = await storage(pool);
    await pool.end();
    let launchError;
    let base = remoteBase;
    if (!base) {
      const runtime = path.join(output, 'runtime', 'dist');
      await cp(path.join(backend, 'dist'), runtime, { recursive: true });
      const port = await unusedPort();
      child = spawn(process.execPath, [path.join(runtime, 'index.js')], { cwd: backend, env: { ...env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', (error) => { launchError = error; });
      child.stdout.on('data', (chunk) => log.push(chunk.toString()));
      child.stderr.on('data', (chunk) => log.push(chunk.toString()));
      base = `http://127.0.0.1:${port}/api`;
    }
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      controller.signal.throwIfAborted();
      if (launchError || (child && child.exitCode !== null)) throw new Error('No arrancó el backend de prueba.');
      try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await delay(200);
    }
    if (!ready) throw new Error('El backend de prueba no respondió al control de inicio.');
    console.log('Inicia la jornada automática. Puedes dejar esta ventana abierta y usar tu PC.');
    console.log(`Resultado: ${output}`);
    const request = makeMeteredRequest(base, records);
    const details = await runWorkload({ plan, fixture, password, request, signal: controller.signal,
      waitUntil: async (minute, start, signal) => {
        const remaining = start + minute / 300 * minutes * 60_000 - performance.now();
        if (remaining > 0) await delay(remaining, undefined, { signal });
      },
      onProgress: (done, total) => console.log(`Progreso: ${done}/${total} eventos.`),
    });
    pool = new pg.Pool({ ...options, connectionString: connection });
    const after = await storage(pool);
    if (after.orders - before.orders !== plan.orders || after.cancelled - before.cancelled !== 2) throw new Error('La comprobación final de pedidos/cancelaciones no coincide.');
    const rowBytes = after.order_row_bytes + after.item_row_bytes + after.selection_row_bytes;
    result = { ...result, completed: true, details, before, after,
      storage: { allocatedGrowthBytes: after.allocated_bytes - before.allocated_bytes, orderRowBytes: rowBytes,
        projectedMonthlyOrderRowBytes: rowBytes * days,
        warning: 'Las filas no incluyen índices/espacio libre; el crecimiento asignado cambia por páginas. No permite prometer cuántos meses caben. Los esquemas de pruebas anteriores también ocupan espacio en este proyecto.' },
    };
    console.log(`Completado: ${details.confirmedOrders} preventas, 5 ediciones, 2 cancelaciones y 4 reportes.`);
  } catch (error) {
    result.error = 'Prueba incompleta; no usar su proyección como jornada completa.';
    // Los errores de conexión podrían contener credenciales: no guardar mensajes externos.
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, delay(5000)]);
    }
    try { await pool.end(); } catch {}
    const redact = (value) => value.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[conexión oculta]');
    const summary = { ...result, startedAt, finishedAt: new Date().toISOString(), traffic: summarize(records, days),
      measurements: {
        backend: remoteBase ? 'Servidor externo de pruebas. Consulta transferencia y horas del servicio en Render antes/después.' : 'Copia local del backend real; no se generó consumo HTTP en Render.',
        neon: 'Si elegiste Neon, consulta CU-h y transferencia en su panel antes/después. Este programa no conoce esos contadores.',
        accelerated: 'Las cachés y el solape de cursores conservan su tiempo real. La prueba acelerada no equivale exactamente a cinco horas.',
        limitations: 'No ejecuta React Native ni SQLite del teléfono; no prueba batería/interfaz. Catálogo sintético sin historial previo.',
      } };
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(path.join(output, 'requests.csv'), 'phase,device,method,route,status,requestBodyBytes,responseBodyBytes,durationMs,error\n' + records.map((r) => [r.phase, r.device, r.method, r.route, r.status || '', r.requestBodyBytes, r.responseBodyBytes, r.durationMs, r.error || ''].join(',')).join('\n'));
    await writeFile(path.join(output, 'setup.log'), redact(log.join('')));
    const traffic = summary.traffic;
    const mb = (bytes) => (bytes / 1_000_000).toFixed(2);
    const report = `# Jornada simulada\n\nEstado: ${result.completed ? 'completada' : 'incompleta'}\n\n- Preconfiguración: ${plan.orders} preventas, ${plan.lines} líneas; ${minutes} minutos reales.\n- Peticiones HTTP: ${traffic.requests}; fallidas: ${traffic.failedRequests}.\n- Cuerpos recibidos: ${mb(traffic.responseBodyBytes)} MB.\n- Cuerpos enviados: ${mb(traffic.requestBodyBytes)} MB.\n- Proyección de cuerpos recibidos (${days} jornadas iguales): ${mb(traffic.projectedMonthlyResponseBodyBytes)} MB.\n\n${traffic.warning}\n\n${summary.measurements.backend}\n\nPara cuotas reales de Neon: anota CU-h y transferencia antes/después en su panel. Revisa summary.json para tamaños de filas, espacio asignado y límites de interpretación. La preparación (migraciones/catálogo) también consume recursos y está fuera del tráfico HTTP medido. No uses proyecciones de una ejecución incompleta.\n`;
    await writeFile(path.join(output, 'LEEME.md'), report);
    console.log(`Informe guardado: ${path.join(output, 'LEEME.md')}`);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[conexión oculta]');
    console.error(`No se completó la simulación: ${message}`);
    process.exitCode = 1;
  });
}

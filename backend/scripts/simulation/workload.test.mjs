import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makePlan, makeMeteredRequest, runWorkload, summarize } from './workload.mjs';
import { assertSafeDatabase, assertSafeApi, ensureEmptyTestDatabase, assertSameWorkDate } from '../simulate-day.mjs';

test('rechaza tablas previas antes de ejecutar cualquier escritura de preparación', async () => {
  const sql = [];
  const pool = { query: async (query) => { sql.push(query); return { rows: [{ tablename: 'orders' }] }; } };
  await assert.rejects(ensureEmptyTestDatabase(pool), /tablas previas/);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT/);
});

test('evita que el cierre automático de medianoche invalide la jornada simulada', () => {
  assert.doesNotThrow(() => assertSameWorkDate(300, Date.parse('2026-11-02T12:00:00Z')));
  assert.throws(() => assertSameWorkDate(300, Date.parse('2026-11-03T01:00:00Z')), /medianoche/);
  assert.doesNotThrow(() => assertSameWorkDate(15, Date.parse('2026-11-03T01:00:00Z')));
});

test('bloquea la base real, incluidas sus variantes pooled/direct', () => {
  const real = 'postgresql://u:p@ep-production-pooler.us-east-2.aws.neon.tech/neondb';
  assert.throws(() => assertSafeDatabase('postgresql://u:p@ep-production.us-east-2.aws.neon.tech/other', [real]), /Bloqueado/);
  assert.throws(() => assertSafeDatabase(real, [real]), /Bloqueado/);
  assert.throws(() => assertSafeDatabase('postgresql://u:p@localhost/ventas', []), /simulation/);
  assert.throws(() => assertSafeDatabase('https://example.com', []), /PostgreSQL/);
  assert.equal(assertSafeDatabase('postgresql://u:p@ep-test.us-east-2.aws.neon.tech/neondb', [real]).hostname, 'ep-test.us-east-2.aws.neon.tech');
});

test('solo admite un servidor externo de pruebas explícito, con HTTPS y sin credenciales', () => {
  assert.equal(assertSafeApi('https://preventapro-pruebas.onrender.com'), 'https://preventapro-pruebas.onrender.com/api');
  assert.equal(assertSafeApi(), null);
  for (const value of ['https://preventapro-backend.onrender.com', 'http://preventapro-test.onrender.com', 'https://u:p@preventapro-test.onrender.com', 'https://preventapro-test.onrender.com/api?x=1', 'https://preventapro-test.onrender.com/not-api']) assert.throws(() => assertSafeApi(value));
});

test('el plan representa 100 ventas y 120 sondeos distribuidos en cinco horas', () => {
  const plan = makePlan();
  assert.equal(plan.events.filter((e) => e.kind === 'sale').length, 100);
  assert.equal(plan.events.filter((e) => e.kind === 'pull').length, 120);
  for (const device of [0, 1]) assert.equal(plan.events.filter((e) => e.kind === 'sale' && e.device === device).length, 50);
  assert.equal(plan.events.at(-1).minute, 300);
  assert.throws(() => makePlan({ orders: 100.5 }), /Preventas/);
  assert.throws(() => makePlan({ lines: 0 }), /Líneas/);
});

test('mide bytes UTF-8 y reportes, sin guardar tokens ni consultas firmadas', async () => {
  const records = [];
  const request = makeMeteredRequest('http://127.0.0.1:4041/api', records, async (url, options) => {
    assert.equal(url.pathname, '/api/reports/a/example.pdf');
    assert.equal(options.redirect, 'error');
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });
  const bytes = await request(0, '/reports/a/example.pdf?download_token=secret', { binary: true, body: { name: 'José' }, method: 'POST', token: 'secret' });
  assert.equal(bytes.length, 3);
  assert.equal(records[0].requestBodyBytes, Buffer.byteLength(JSON.stringify({ name: 'José' })));
  assert.equal(records[0].responseBodyBytes, 3);
  assert.ok(!JSON.stringify(records).includes('secret'));
  assert.equal(summarize(records, 26).projectedMonthlyResponseBodyBytes, 78);
});

test('un HTTP 200 con una operación fallida no se cuenta como venta confirmada', async () => {
  const fixture = sampleFixture();
  const request = async (device, route) => {
    if (route === '/auth/login') return { accessToken: 'session' };
    if (route === '/workdays/current') return { workDay: { id: 'day', status: 'open' } };
    if (route.startsWith('/sync/pull')) return { products: [{ id: fixture.products[0].id }], cursor: new Date().toISOString() };
    return { results: [{ status: 'failed' }] };
  };
  await assert.rejects(runWorkload({ plan: makePlan(), fixture, request, waitUntil: async () => {} }), /confirmación/);
});

function sampleFixture() {
  return {
    users: [{ code: 'a' }, { code: 'b' }], clients: ['client-1', 'client-2'],
    products: Array.from({ length: 20 }, (_, i) => ({ id: `product-${i}`, presentationId: `presentation-${i}`, priceCents: 500 })),
    combo: { id: 'combo', presentationId: 'combo-presentation', priceCents: 900 },
  };
}

test('recorre la jornada completa: pendientes offline, idempotencia, ediciones, cancelaciones y descargas', async () => {
  const fixture = sampleFixture();
  const saved = new Map();
  const calls = [];
  const comboOrders = new Set();
  let creates = 0, edits = 0, cancels = 0, downloads = 0, pulls = 0;
  const request = async (device, route, options = {}) => {
    options.signal?.throwIfAborted();
    calls.push({ device, route });
    if (route === '/auth/login') return { accessToken: `session-${device}` };
    if (route === '/workdays/current') return { workDay: { id: 'day', status: 'open' } };
    if (route.startsWith('/sync/pull')) { pulls++; return { products: [{ id: fixture.products[0].id }], cursor: new Date().toISOString() }; }
    if (route === '/sync/push') {
      const op = options.body.operations[0];
      if (op.operation === 'create') {
        creates++;
        saved.set(op.data.idempotencyKey, `server-${op.id}`);
        if (op.data.items.some((i) => i.selections)) comboOrders.add(op.id);
      } else if (op.operation === 'update') edits++;
      else if (op.operation === 'cancel') cancels++;
      return { results: [{ status: 'synced', serverId: saved.get(op.data.idempotencyKey) }] };
    }
    if (route.endsWith('/download-token')) return { downloadToken: 'signed' };
    if (route.startsWith('/reports/')) { downloads++; return Buffer.from('report'); }
    return {};
  };
  const result = await runWorkload({ plan: makePlan(), fixture, request, waitUntil: async () => {} });
  assert.equal(saved.size, 100);
  assert.equal(result.confirmedOrders, 100);
  assert.equal(creates, 102); // Dos reintentos con la misma clave, sin nuevos pedidos.
  assert.equal(edits, 5);
  assert.equal(cancels, 2);
  assert.equal(comboOrders.size, 20);
  assert.equal(downloads, 4);
  assert.equal(pulls, 116); // 120 sondeos menos seis offline, más dos iniciales.
  assert.equal(result.offlineQueued, 5);
  assert.equal(calls.length, 240);
  assert.ok(calls.findIndex((c) => c.route.endsWith('/close')) > calls.map((c) => c.route).lastIndexOf('/sync/push'));
});

test('la vista previa funciona sin configuración ni conexión', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/simulate-day.mjs'], { cwd: new URL('../../', import.meta.url) });
  assert.match(stdout, /Vista previa/);
  assert.match(stdout, /100 preventas/);
});

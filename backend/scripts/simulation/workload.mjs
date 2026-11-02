import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const DAY_MINUTES = 300;

export function makePlan({ orders = 100, lines = 8 } = {}) {
  if (!Number.isInteger(orders) || orders < 10 || orders > 1000) throw new Error('Preventas: entre 10 y 1000.');
  if (!Number.isInteger(lines) || lines < 1 || lines > 50) throw new Error('Líneas por preventa: entre 1 y 50.');
  const events = [];
  for (let index = 0; index < orders; index++) {
    events.push({ minute: (index + 0.5) * DAY_MINUTES / orders, device: index % 2, kind: 'sale', index });
  }
  for (let minute = 5; minute <= DAY_MINUTES; minute += 5) {
    for (let device = 0; device < 2; device++) events.push({ minute, device, kind: 'pull' });
  }
  // B acumula pendientes de 90 a 120 minutos virtuales; no pierde las capturas.
  events.push({ minute: 120, device: 1, kind: 'reconnect' });
  for (let index = 0; index < 2; index++) events.push({ minute: 210 + index, device: index % 2, kind: 'retry', index });
  for (let index = 0; index < 5; index++) events.push({ minute: 230 + index, device: index % 2, kind: 'edit', index });
  for (let index = 6; index < 8; index++) events.push({ minute: 270 + index, device: index % 2, kind: 'cancel', index });
  return { orders, lines, virtualMinutes: DAY_MINUTES, events: events.sort((a, b) => a.minute - b.minute) };
}

export function makeMeteredRequest(baseUrl, records, fetchImpl = fetch) {
  const base = new URL(baseUrl);
  return async function request(device, route, { method = 'GET', body, token, phase = 'workload', binary = false, signal } = {}) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Ruta de simulación inválida.');
    const url = new URL(`${base.pathname.replace(/\/$/, '')}${route}`, base.origin);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const started = performance.now();
    const record = { phase, device, method, route: route.split('?')[0], requestBodyBytes: Buffer.byteLength(encoded || ''), responseBodyBytes: 0 };
    try {
      const response = await fetchImpl(url, {
        method, body: encoded, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        headers: { ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      record.status = response.status;
      record.responseBodyBytes = bytes.length;
      if (!response.ok) throw new Error(`HTTP ${response.status} en ${record.route}`);
      return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    } catch (error) {
      record.error = error.name === 'TimeoutError' ? 'timeout' : 'request_failed';
      throw error;
    } finally {
      record.durationMs = Math.round(performance.now() - started);
      records.push(record);
    }
  };
}

export async function runWorkload({ plan, fixture, password, request, waitUntil, onProgress = () => {}, signal }) {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const send = request;
  request = (device, route, options = {}) => send(device, route, { ...options, signal: combinedSignal });
  const devices = fixture.users.map((user) => ({ user, queue: [], cursor: null, token: null }));
  const sales = new Map();
  const confirmed = new Map();
  let workDayId;
  let offlineQueued = 0;

  for (let d = 0; d < 2; d++) {
    const login = await request(d, '/auth/login', { method: 'POST', phase: 'startup', body: { identifier: devices[d].user.code, password, deviceName: `Simulador ${d + 1}` } });
    if (!login.accessToken) throw new Error('El login no devolvió una sesión.');
    devices[d].token = login.accessToken;
    const current = await request(d, '/workdays/current', { token: devices[d].token, phase: 'startup' });
    if (!current.workDay?.id || current.workDay.status !== 'open') throw new Error('La jornada de prueba debe estar abierta. Usa una base de prueba nueva para otra jornada del mismo día.');
    if (workDayId && current.workDay.id !== workDayId) throw new Error('Los dispositivos no comparten jornada.');
    workDayId = current.workDay.id;
    const pulled = await request(d, '/sync/pull?since=1970-01-01T00%3A00%3A00.000Z', { token: devices[d].token, phase: 'startup' });
    if (!pulled.products?.some((p) => p.id === fixture.products[0].id)) throw new Error('El servidor no pertenece a la base de simulación configurada.');
    devices[d].cursor = pulled.cursor || pulled.serverTime;
  }

  async function push(d, operation) {
    const result = await request(d, '/sync/push', { method: 'POST', token: devices[d].token, body: { operations: [operation] } });
    const ack = result.results?.[0];
    if (ack?.status !== 'synced' || !ack.serverId) throw new Error(`La operación ${operation.operation} falló (no hubo confirmación válida).`);
    if (operation.operation === 'create') confirmed.set(operation.id, ack.serverId);
  }
  async function flush(d) {
    while (devices[d].queue.length) {
      await push(d, devices[d].queue[0]);
      devices[d].queue.shift();
    }
  }
  function sale(index) {
    const id = randomUUID();
    const items = Array.from({ length: plan.lines }, (_, line) => {
      const product = fixture.products[(index + line) % fixture.products.length];
      return { productId: product.id, presentationId: product.presentationId, quantity: 1 + (index + line) % 3, unitPriceCents: product.priceCents };
    });
    if (index % 5 === 0) {
      items[items.length - 1] = {
        productId: fixture.combo.id, presentationId: fixture.combo.presentationId, quantity: 1,
        unitPriceCents: fixture.combo.priceCents,
        selections: fixture.products.slice(0, 2).map((p) => ({ selectedProductId: p.id, selectedPresentationId: p.presentationId, quantity: 1 })),
      };
    }
    return { id, entityType: 'order', operation: 'create', data: {
      idempotencyKey: id, workDayId, clientId: fixture.clients[index % fixture.clients.length],
      createdAt: new Date().toISOString(), paymentCondition: index % 3 ? 'cash' : 'credit', taxRatePermille: 0, items,
    } };
  }

  const started = performance.now();
  let processed = 0;
  // Cada teléfono respeta su orden; ambos pueden enviar peticiones a la vez.
  const workers = await Promise.allSettled(devices.map(async (_, d) => {
    try {
    for (const event of plan.events.filter((item) => item.device === d)) {
      combinedSignal.throwIfAborted();
      await waitUntil(event.minute, started, combinedSignal);
      const offline = d === 1 && event.minute >= 90 && event.minute < 120;
      if (event.kind === 'sale') {
        const operation = sale(event.index);
        sales.set(event.index, operation);
        if (offline) { devices[d].queue.push(operation); offlineQueued++; }
        else { await flush(d); await push(d, operation); }
      } else if (event.kind === 'reconnect') {
        await flush(d);
      } else if (event.kind === 'pull' && !offline) {
        await flush(d);
        // Reproduce el margen del móvil; el backend añade su propio solape.
        const since = new Date(Math.max(0, Date.parse(devices[d].cursor) - 120_000)).toISOString();
        const pulled = await request(d, `/sync/pull?since=${encodeURIComponent(since)}`, { token: devices[d].token });
        devices[d].cursor = pulled.cursor || pulled.serverTime;
      } else if (event.kind === 'edit' || event.kind === 'retry' || event.kind === 'cancel') {
        const original = sales.get(event.index);
        if (!original || !confirmed.has(original.id)) throw new Error('Una edición/reintento precedió a la preventa original.');
        const operation = structuredClone(original);
        if (event.kind === 'edit') {
          operation.operation = 'update';
          operation.data.serverId = confirmed.get(original.id);
          operation.data.items[0].quantity++;
        } else if (event.kind === 'cancel') {
          operation.operation = 'cancel';
          operation.data.serverId = confirmed.get(original.id);
        }
        await push(d, operation);
      }
      processed++;
      if (processed % 20 === 0) onProgress(processed, plan.events.length);
    }
    await flush(d);
    } catch (error) { controller.abort(error); throw error; }
  }));
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed) throw failed.reason;

  const token = devices[0].token;
  await request(0, `/workdays/${workDayId}/close`, { method: 'POST', token, phase: 'closing', body: { confirmation: 'CONFIRMAR' } });
  for (const name of ['lista_de_productos.xlsx', 'resumen_clientes.xlsx', 'boletas_clientes.xlsx', 'boletas_clientes.pdf']) {
    const download = await request(0, `/reports/${workDayId}/download-token`, { method: 'POST', token, phase: 'reports' });
    if (!download.downloadToken) throw new Error('No se emitió el enlace de reportes.');
    const bytes = await request(0, `/reports/${workDayId}/${name}?download_token=${encodeURIComponent(download.downloadToken)}`, { binary: true, phase: 'reports' });
    if (!bytes.length) throw new Error('Reporte vacío.');
  }
  // Cerrar las dos sesiones como lo hace la app.
  for (let d = 0; d < 2; d++) await request(d, '/auth/logout', { method: 'POST', token: devices[d].token, phase: 'closing' });
  return { workDayId, confirmedOrders: confirmed.size, offlineQueued, editedOrders: 5, cancelledOrders: 2 };
}

export function summarize(records, days = 30) {
  const total = (key) => records.reduce((sum, record) => sum + record[key], 0);
  const times = records.map((r) => r.durationMs).sort((a, b) => a - b);
  return {
    requests: records.length, failedRequests: records.filter((r) => r.error).length,
    requestBodyBytes: total('requestBodyBytes'), responseBodyBytes: total('responseBodyBytes'),
    p95Ms: times.length ? times[Math.ceil(times.length * 0.95) - 1] : 0,
    projectedMonthlyResponseBodyBytes: total('responseBodyBytes') * days,
    projectionDays: days,
    warning: 'Cuerpos HTTP leídos por el cliente, sin cabeceras/TLS ni consultas SQL. No equivale a la transferencia facturada por Render o Neon. Incluye una descarga inicial completa en cada teléfono; es una proyección conservadora de ese patrón, no del uso estable.',
  };
}

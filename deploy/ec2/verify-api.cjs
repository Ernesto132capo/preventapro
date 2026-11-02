#!/usr/bin/env node
// Read-only API verification with a short-lived token; never logs customer data.
const fs = require('node:fs');
const crypto = require('node:crypto');
const dotenv = require('/opt/preventapro/backend/node_modules/dotenv');
const { Client } = require('/opt/preventapro/backend/node_modules/pg');
async function main() {
  const env = dotenv.parse(fs.readFileSync('/etc/preventapro/backend.env'));
  // Read the root-only configuration, then use the same OS identity as the API.
  // PostgreSQL authenticates this service account through its local Unix socket.
  if (process.getuid() === 0) {
    process.initgroups('preventapro', 'preventapro');
    process.setgid('preventapro');
    process.setuid('preventapro');
  }
  const sourceUrl = new URL(env.DATABASE_URL);
  const source = new Client({ connectionString: sourceUrl.href, connectionTimeoutMillis: 15000 });
  await source.connect();
  let userId, orderId;
  try {
    userId = (await source.query('SELECT id FROM users WHERE active=true ORDER BY id LIMIT 1')).rows[0]?.id;
    orderId = (await source.query('SELECT id FROM orders ORDER BY id LIMIT 1')).rows[0]?.id;
  } finally { await source.end(); }
  if (!userId) throw new Error('No active user available for verification');
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc({ typ: 'access', sub: userId, iat: now, exp: now + 120 });
  const token = unsigned + '.' + crypto.createHmac('sha256', env.AUTH_TOKEN_SECRET).update(unsigned).digest('base64url');
  const base = process.argv[2] || 'https://18.227.163.204/api';
  const results = [];
  let products, clients;
  for (const route of ['/health', '/auth/me', '/catalog/categories', '/catalog/products', '/clients', '/workdays/history', '/settings/stats', ...(orderId ? ['/orders/' + encodeURIComponent(orderId)] : [])]) {
    const started = Date.now();
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(90000), redirect: 'error' });
    if (!response.ok) throw new Error('API check failed: ' + route.split('/').slice(0, 2).join('/') + ' HTTP ' + response.status);
    const body = await response.json();
    if (route === '/catalog/products') products = body.products;
    if (route === '/clients') clients = body.clients;
    results.push({ route: route.startsWith('/orders/') ? '/orders/:id' : route, status: response.status, milliseconds: Date.now() - started });
  }
  if (!products?.length || !clients?.length) throw new Error('Migrated catalog or clients are missing from API');
  const product = products.find(value => value.product_type !== 'combo' && value.presentations?.some(p => p.active !== false));
  const presentation = product?.presentations?.find(p => p.active !== false);
  if (!product || !presentation) throw new Error('No active standard product to validate');
  const response = await fetch(base + '/orders/validate', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, presentationId: presentation.id, quantity: 1, unitPriceCents: Number(presentation.price_cents) }] }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Order validation failed: HTTP ' + response.status);
  const validation = await response.json();
  if (validation.issues?.length) throw new Error('Unexpected catalog validation issues');
  results.push({ route: '/orders/validate', status: response.status });
  console.log(JSON.stringify({ result: 'PUBLIC_API_VERIFIED', base, activeProducts: products.length, activeClients: clients.length, checks: results }, null, 2));
}
main().catch(error => { console.error(error.name, error.cause?.code || '', String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted]')); process.exitCode = 1; });

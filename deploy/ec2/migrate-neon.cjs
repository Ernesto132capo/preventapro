#!/usr/bin/env node
// Run as root on EC2. Secrets arrive only over SSH stdin, never as arguments/logs.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('/opt/preventapro/backend/node_modules/pg');
process.umask(0o077);

function psql(sql) {
  return execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c', sql], { encoding: 'utf8' }).trim();
}
function quote(name) { return '"' + name.replaceAll('"', '""') + '"'; }
function digestSql(table) {
  return `SELECT count(*)::text AS rows, coalesce(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest FROM public.${quote(table)} t`;
}
function localDigest(table) {
  const sql = `SET timezone='UTC'; SELECT row_to_json(x) FROM (${digestSql(table)}) x;`;
  return JSON.parse(execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-d', 'preventapro', '-c', sql], { encoding: 'utf8' }).trim());
}
async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const url = new URL(input.sourceUrl);
  if (!url.hostname.endsWith('.neon.tech')) throw new Error('Expected the configured Neon source');
  url.hostname = url.hostname.replace('-pooler.', '.');
  url.searchParams.set('sslmode', 'verify-full');
  if (typeof input.authSecret !== 'string' || input.authSecret.length < 32 || /[\r\n\0]/.test(input.authSecret)) throw new Error('Invalid application signing secret');
  if (psql("SELECT count(*) FROM pg_database WHERE datname='preventapro'") !== '0') throw new Error('Destination already exists; refusing to overwrite it');
  const source = new Client({ connectionString: url.href, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 15000 });
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '');
  const archive = `/var/backups/preventapro/neon-source-${stamp}.dump`;
  const manifestPath = archive + '.json';
  let manifest;
  await source.connect();
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await source.query("SET LOCAL timezone='UTC'");
    const version = (await source.query('SHOW server_version_num')).rows[0].server_version_num;
    if (Number(version) < 180000 || Number(version) >= 190000) throw new Error('Source PostgreSQL version differs from the verified version 18');
    const snapshot = (await source.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
    const tables = (await source.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
    const before = {};
    for (const table of tables) before[table] = (await source.query(digestSql(table))).rows[0];
    const pgEnv = {
      ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/etc/ssl/certs/ca-certificates.crt', PGCONNECT_TIMEOUT: '15',
      PGOPTIONS: '-c default_transaction_read_only=on',
    };
    execFileSync('/usr/lib/postgresql/18/bin/pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot, '--file=' + archive], { env: pgEnv, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.chmodSync(archive, 0o600);
    execFileSync('/usr/lib/postgresql/18/bin/pg_restore', ['--list', archive], { timeout: 30000 });
    manifest = { exported_at: new Date().toISOString(), source_version_num: version, sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), bytes: fs.statSync(archive).size, tables: before };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  } finally {
    await source.query('ROLLBACK').catch(() => {});
    await source.end();
  }
  // Preserve the verified source export off-instance before creating/restoring the destination.
  const upload = `import boto3,json,sys,pathlib\nc=json.loads(pathlib.Path('/etc/preventapro/ops.json').read_text())\np=pathlib.Path(sys.argv[1]);m=json.loads(pathlib.Path(sys.argv[2]).read_text());s=boto3.client('s3',region_name=c['region']);k=c['s3_prefix'].rstrip('/')+'/migrations/'+p.name\nwith p.open('rb') as f:s.put_object(Bucket=c['s3_bucket'],Key=k,Body=f,ServerSideEncryption='AES256',Metadata={'sha256':m['sha256']})\nh=s.head_object(Bucket=c['s3_bucket'],Key=k)\nassert h['ContentLength']==m['bytes'] and h['Metadata']['sha256']==m['sha256']\ns.put_object(Bucket=c['s3_bucket'],Key=k+'.json',Body=json.dumps(m).encode(),ServerSideEncryption='AES256',ContentType='application/json')\nprint('SOURCE_BACKUP_S3_VERIFIED')`;
  console.log(execFileSync('python3', ['-c', upload, archive, manifestPath], { encoding: 'utf8', timeout: 120000 }).trim());
  if (psql("SELECT count(*) FROM pg_roles WHERE rolname='preventapro'") === '0') psql('CREATE ROLE preventapro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
  execFileSync('runuser', ['-u', 'postgres', '--', 'createdb', '--owner=preventapro', '--template=template0', '--encoding=UTF8', 'preventapro']);
  execFileSync('runuser', ['-u', 'postgres', '--', 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--role=preventapro', '--dbname=preventapro'], { input: fs.readFileSync(archive), timeout: 300000 });
  for (const [table, expected] of Object.entries(manifest.tables)) {
    const actual = localDigest(table);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored table verification differs: ' + table);
  }
  const env = {
    NODE_ENV: 'production', PORT: '4000',
    DATABASE_URL: 'postgresql://preventapro@localhost:5432/preventapro?host=%2Fvar%2Frun%2Fpostgresql&sslmode=disable',
    AUTH_TOKEN_SECRET: input.authSecret,
  };
  const envPath = '/etc/preventapro/backend.env';
  if (fs.existsSync(envPath)) throw new Error('Application environment already exists; preserve it and activate explicitly');
  fs.writeFileSync(envPath, Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  manifest.restored_at = new Date().toISOString();
  manifest.archive = archive;
  manifest.all_tables_verified = true;
  fs.writeFileSync('/var/lib/preventapro-ops/neon-migration.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ result: 'NEON_MIGRATION_VERIFIED', archive, sha256: manifest.sha256, bytes: manifest.bytes, tables: Object.fromEntries(Object.entries(manifest.tables).map(([table, data]) => [table, data.rows])) }));
}
main().catch(error => {
  // Child command errors may contain connection details: never dump the full error object.
  console.error('MIGRATION_FAILED', error.code || error.name, String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted]').slice(0, 300));
  process.exitCode = 1;
});

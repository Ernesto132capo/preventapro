#!/usr/bin/env node
// Local helper: transfer existing configuration through encrypted stdin only.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dotenv = require(path.join(root, 'backend/node_modules/dotenv'));
const args = process.argv.slice(2);
const options = Object.fromEntries(args.map((value, index) => value.startsWith('--') ? [value.slice(2), args[index + 1]] : null).filter(Boolean));
for (const key of ['identity', 'known-hosts', 'host', 'source-env']) if (!options[key]) throw new Error('Historical migration only: missing --' + key);
const env = dotenv.parse(fs.readFileSync(path.resolve(options['source-env'])));
const payload = { sourceUrl: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL, authSecret: env.AUTH_TOKEN_SECRET };
const ssh = ['-F', 'NUL', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + options['known-hosts'], '-o', 'ConnectTimeout=10', '-i', options.identity, 'ubuntu@' + options.host, 'sudo node /tmp/preventapro-migrate-neon.cjs'];
const result = spawnSync('ssh', ssh, { input: JSON.stringify(payload), encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024 });
if (result.error) console.error(result.error.code || result.error.name);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;

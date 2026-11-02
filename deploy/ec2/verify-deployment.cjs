#!/usr/bin/env node
// Execute the read-only check on EC2; no production secret is needed on the PC.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { settings, connectionArgs } = require('../../backend/scripts/ec2-ssh.cjs');
const env = settings();
const source = fs.readFileSync(path.join(__dirname, 'verify-api.cjs'));
const result = spawnSync('ssh', [...connectionArgs(env), env.EC2_SSH_USER + '@' + env.EC2_SSH_HOST, 'sudo node -'],
  { input: source, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error.code || 'SSH_CHECK_FAILED');
process.exitCode = result.status ?? 1;

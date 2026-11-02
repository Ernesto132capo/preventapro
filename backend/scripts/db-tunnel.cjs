#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { settings, connectionArgs } = require('./ec2-ssh.cjs');
const env = settings();
const port = Number(env.EC2_LOCAL_DB_PORT || 55432);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Puerto local inválido');
console.log(`Túnel de desarrollo en 127.0.0.1:${port}. Mantén esta terminal abierta.`);
const child = spawn('ssh', [...connectionArgs(env), '-o', 'ExitOnForwardFailure=yes', '-N',
  '-L', `127.0.0.1:${port}:127.0.0.1:5432`, `${env.EC2_SSH_USER}@${env.EC2_SSH_HOST}`], { stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('No se pudo iniciar SSH.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1); });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());

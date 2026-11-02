const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function settings() {
  const env = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '../.env')));
  for (const key of ['EC2_SSH_HOST', 'EC2_SSH_USER', 'EC2_SSH_KEY_PATH', 'EC2_SSH_KNOWN_HOSTS']) {
    if (!env[key]) throw new Error('Falta configurar ' + key + ' en backend/.env');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(env.EC2_SSH_HOST) || !/^[a-z_][a-z0-9_-]*$/i.test(env.EC2_SSH_USER)) {
    throw new Error('Host o usuario SSH inválido');
  }
  for (const key of ['EC2_SSH_KEY_PATH', 'EC2_SSH_KNOWN_HOSTS']) {
    if (!path.isAbsolute(env[key]) || !fs.statSync(env[key]).isFile()) throw new Error('Revisa el archivo ' + key);
  }
  return env;
}

function connectionArgs(env) {
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + env.EC2_SSH_KNOWN_HOSTS,
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-i', env.EC2_SSH_KEY_PATH];
}

module.exports = { settings, connectionArgs };

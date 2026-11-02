#!/usr/bin/env node
// Poll the already requested Expo build; never upgrade a plan or create another build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
const required = ['build', 'eas-cli', 'output', 'status', 'sdk', 'java', 'python'];
for (const key of required) if (!args[key]) throw new Error('Missing argument: ' + key);
const mobile = path.resolve(__dirname, '../../mobile');
const deadline = Date.now() + 2 * 60 * 60 * 1000;
const state = { buildId: args.build, output: args.output, status: 'STARTING' };
function save() {
  state.checkedAt = new Date().toISOString();
  fs.writeFileSync(args.status, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
function execute(command, values) {
  const result = spawnSync(command, values, { cwd: mobile, encoding: 'utf8', timeout: 90000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Command failed: ' + path.basename(command));
  return result.stdout;
}
async function download(url) {
  if (new URL(url).protocol !== 'https:') throw new Error('Expected HTTPS artifact');
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error('Artifact HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > 500 * 1024 * 1024) throw new Error('Unexpected artifact size');
  const part = args.output + '.part';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part, { flags: 'wx' }));
  try {
    const manifest = execute(path.join(args.sdk, 'aapt.exe'), ['dump', 'badging', part]).split('\n')[0];
    if (!manifest.includes("name='bo.preventapro.app'") || !manifest.includes("versionCode='4'") || !manifest.includes("versionName='1.0.3'")) throw new Error('Unexpected APK identity/version');
    execute(args.java, ['-jar', path.join(args.sdk, 'lib/apksigner.jar'), 'verify', part]);
    execute(args.python, ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); names=[n for n in z.namelist() if n.endswith("index.android.bundle")]; assert names, "Missing bundle"; assert any(b"https://18.227.163.204/api" in z.read(n) for n in names), "Wrong API endpoint"; print("EC2_ENDPOINT_VERIFIED")', part]);
    if (fs.existsSync(args.output)) throw new Error('Output already exists; refusing to replace it');
    fs.renameSync(part, args.output);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(args.output)) hash.update(chunk);
    Object.assign(state, { status: 'READY', bytes: fs.statSync(args.output).size, sha256: hash.digest('hex'), package: 'bo.preventapro.app', version: '1.0.3', versionCode: 4, signatureVerified: true, apiVerified: true });
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
}
async function main() {
  save();
  while (Date.now() < deadline) {
    const build = JSON.parse(execute(process.execPath, [args['eas-cli'], 'build:view', args.build, '--json']));
    if (build.id !== args.build || build.appVersion !== '1.0.3' || String(build.appBuildVersion) !== '4') throw new Error('Unexpected build metadata');
    state.status = build.status;
    save();
    if (build.status === 'FINISHED') {
      if (!build.artifacts?.buildUrl) throw new Error('Finished build has no artifact');
      await download(build.artifacts.buildUrl);
      save();
      console.log('APK_READY=' + args.output);
      return;
    }
    if (['ERRORED', 'CANCELED'].includes(build.status)) throw new Error('Expo build status: ' + build.status);
    if (args.once) return;
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
  throw new Error('Build wait exceeded two hours; the Expo build remains available online');
}
main().catch(error => {
  state.status = 'NEEDS_REVIEW';
  state.error = error.message; // Only local, controlled messages; never signed artifact URLs.
  save();
  console.error(state.error);
  process.exitCode = 1;
});

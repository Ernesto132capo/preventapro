#!/usr/bin/env node
// Expo SDK 51 downloads this exact SQLite archive while running Gradle.
// Point its Gradle download task at a verified local archive. Gradle can relocate
// build/download directories, so seeding an assumed cache path is insufficient.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (process.env.EAS_BUILD_PLATFORM && process.env.EAS_BUILD_PLATFORM !== 'android') {
  console.log('SQLite Android preparation skipped for this platform.');
  process.exit(0);
}

const version = '3450300';
const expectedHash = 'ea170e73e447703e8359308ca2e4366a3ae0c4304a8665896f068c736781c651';
const filename = `sqlite-amalgamation-${version}.zip`;
const mobile = path.resolve(__dirname, '..');
const sqlite = path.dirname(path.dirname(require.resolve('expo-sqlite', { paths: [mobile] })));
if (JSON.parse(fs.readFileSync(path.join(sqlite, 'package.json'), 'utf8')).name !== 'expo-sqlite') {
  throw new Error('Cannot locate the expo-sqlite package root.');
}
const gradlePath = path.join(sqlite, 'android/build.gradle');
const gradle = fs.readFileSync(gradlePath, 'utf8');
if (!new RegExp(`SQLITE_VERSION\\s*=\\s*['"]${version}['"]`).test(gradle) || !/overwrite\(false\)/.test(gradle)) {
  throw new Error('expo-sqlite changed its native download configuration; review the vendored SQLite archive.');
}

const archivePath = fs.realpathSync(path.join(mobile, 'vendor/sqlite', filename));
const archive = fs.readFileSync(archivePath);
const digest = crypto.createHash('sha256').update(archive).digest('hex');
if (digest !== expectedHash) throw new Error('Vendored SQLite SHA-256 mismatch.');

const remoteSource = 'src("https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip")';
const marker = '// PreventaPro verified local SQLite source';
const literalPath = "'" + archivePath.replace(/\\/g, '/').replace(/'/g, "\\'") + "'";
const localSource = `src(new File(${literalPath}).toURI().toString()) ${marker}`;
let prepared;
if (gradle.includes(remoteSource)) {
  prepared = gradle.replace(remoteSource, localSource);
} else if (gradle.includes(marker)) {
  prepared = gradle.replace(/^\s*src\(new File\(.+\)\.toURI\(\)\.toString\(\)\) \/\/ PreventaPro verified local SQLite source$/m, '  ' + localSource);
} else {
  throw new Error('Cannot identify the expo-sqlite download source; review the native build hook.');
}
if (!prepared.includes(localSource) || prepared.includes(remoteSource)) {
  throw new Error('Failed to configure the verified local SQLite source.');
}
fs.writeFileSync(gradlePath, prepared);
console.log(`SQLite ${version} verified: ${digest}`);
console.log('Gradle SQLite source: ' + archivePath);

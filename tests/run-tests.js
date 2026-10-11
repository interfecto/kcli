#!/usr/bin/env node
// Runs the regression tests against THIS checkout's build. Several tests spawn `kcli` from PATH, so a plain
// `node --test` exercises whatever kcli is linked globally, which may be an older build than the dist/ that
// `npm test` has just produced. This runner writes a temporary shim into the ignored .release-test-bin/
// directory, puts it first on PATH, verifies that `kcli` resolves to it, runs node --test and removes it.
// POSIX only (sh shim), like the other test helpers.
// usage: npm test [-- test file ...]   (default: tests/*.test.js, sorted; `npm test` builds first)
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist', 'index.js');
const log = message => console.error('tests/run-tests.js: ' + message);
if (!fs.existsSync(dist)) { log('missing ' + dist + '; run `npm run build` first'); process.exit(2); }
const files = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('tests', f));
if (files.length === 0) { log('no test files'); process.exit(2); }

const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const binRoot = path.join(root, '.release-test-bin');
fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 });
const shimDir = fs.mkdtempSync(path.join(binRoot, 'run-'));
const shim = path.join(shimDir, 'kcli');
const cleanup = () => fs.rmSync(shimDir, { recursive: true, force: true });
// Re-raise a signal with the default disposition after cleanup, so the caller sees the real termination cause.
const raise = signal => { process.removeAllListeners(signal); cleanup(); process.kill(process.pid, signal); setTimeout(() => process.exit(1), 2000); };

fs.writeFileSync(shim, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(dist) + ' "$@"\n', { mode: 0o755 });
const env = { ...process.env, PATH: shimDir + path.delimiter + (process.env.PATH || '') };
const resolved = spawnSync('sh', ['-c', 'command -v kcli'], { env, encoding: 'utf8' });
if (resolved.status !== 0 || resolved.stdout.trim() !== shim) {
  log('kcli does not resolve to the shim: ' + ((resolved.stdout || '') + (resolved.stderr || '')).trim()); cleanup(); process.exit(2);
}

const child = spawn(process.execPath, ['--test', ...files], { cwd: root, env, stdio: 'inherit' });
let forwarded = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { forwarded = forwarded || signal; child.kill(signal); });
child.on('error', error => { log(error.message); cleanup(); process.exit(1); });
child.on('exit', (code, signal) => {
  cleanup();
  const cause = signal || forwarded;
  if (cause) { log('node --test ended by ' + cause); raise(cause); } else process.exit(code === null ? 1 : code);
});

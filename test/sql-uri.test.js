/**
 * SQL_URI resolution: explicit value, $STATE_DIRECTORY default, cwd
 * fallback. Each case runs in a subprocess with a clean environment and a
 * cwd without a .env file, so the local .env cannot interfere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const configUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'config.js'));

async function sqlUriWith(env) {
  const { stdout } = await run(
    process.execPath,
    ['--input-type=module', '-e', `const { config } = await import('${configUrl}'); console.log(config.sqlUri);`],
    { cwd: os.tmpdir(), env: { PATH: process.env.PATH, ...env } }
  );
  return stdout.trim();
}

test('SQL_URI wins when set', async () => {
  assert.equal(
    await sqlUriWith({ SQL_URI: 'postgres://db.example/launcher' }),
    'postgres://db.example/launcher'
  );
});

test('defaults to a SQLite file in $STATE_DIRECTORY', async () => {
  assert.equal(
    await sqlUriWith({ STATE_DIRECTORY: '/var/lib/ozwell-studio-launcher' }),
    'sqlite:/var/lib/ozwell-studio-launcher/db.sqlite'
  );
});

test('falls back to the working directory without $STATE_DIRECTORY', async () => {
  assert.equal(await sqlUriWith({}), `sqlite:${path.join(os.tmpdir(), 'db.sqlite')}`);
});

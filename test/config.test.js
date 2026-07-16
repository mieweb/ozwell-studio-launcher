/** Config fails fast on malformed values instead of shipping NaN. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = 'not-a-number';

test('a non-numeric numeric variable rejects at load', async () => {
  await assert.rejects(() => import('../src/config.js'), /PORT must be a number/);
});

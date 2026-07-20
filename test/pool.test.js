/** Warm-pool persistence: migrations + FIFO take/add on in-memory SQLite. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { QueryTypes } from 'sequelize';

process.env.SQL_URI = 'sqlite::memory:';
process.env.LOG_LEVEL = 'warn';

const { sequelize } = await import('../src/db/index.js');
const { migrate } = await import('../src/db/migrate.js');
const pool = await import('../src/studios/pool.js');

before(async () => {
  await migrate(sequelize);
});

test('migrate is idempotent and records applied migrations once', async () => {
  await migrate(sequelize); // second run: nothing to do, nothing to break
  const rows = await sequelize.query('SELECT name FROM migrations', {
    type: QueryTypes.SELECT,
  });
  assert.deepEqual(
    rows.map((r) => r.name),
    ['20260716130904-pooled-studios.js']
  );
});

test('take on an empty pool returns null', async () => {
  assert.equal(await pool.take(), null);
});

test('take removes entries first-in-first-out', async () => {
  await pool.add('ozwell-studio-aaaa0001');
  await pool.add('ozwell-studio-bbbb0002');
  await pool.add('ozwell-studio-cccc0003');
  assert.equal(await pool.count(), 3);

  assert.equal(await pool.take(), 'ozwell-studio-aaaa0001');
  assert.equal(await pool.take(), 'ozwell-studio-bbbb0002');
  assert.equal(await pool.count(), 1);
  assert.equal(await pool.take(), 'ozwell-studio-cccc0003');
  assert.equal(await pool.take(), null);
});

test('a hostname cannot be pooled twice', async () => {
  await pool.add('ozwell-studio-dddd0004');
  await assert.rejects(() => pool.add('ozwell-studio-dddd0004'));
  assert.equal(await pool.take(), 'ozwell-studio-dddd0004');
});

test('a re-added hostname goes to the back of the queue', async () => {
  await pool.add('ozwell-studio-eeee0005');
  await pool.add('ozwell-studio-ffff0006');
  const first = await pool.take();
  assert.equal(first, 'ozwell-studio-eeee0005');
  await pool.add(first); // e.g. returned after a failed claim
  assert.equal(await pool.take(), 'ozwell-studio-ffff0006');
  assert.equal(await pool.take(), 'ozwell-studio-eeee0005');
});

/**
 * Startup migrations: a tiny forward-only migrator. Migration files live
 * in migrations/, named `YYYYMMDDHHmmSS-description.js` so filename order
 * is creation order; applied names are recorded in a `migrations` table.
 *
 * When several launcher instances share a server database, the run is
 * serialized with an advisory lock (postgres pg_advisory_xact_lock,
 * mysql/mariadb GET_LOCK). SQLite needs none: it is a local file with a
 * single instance, and its own file locking covers the rest.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DataTypes, QueryTypes } from 'sequelize';
import { logger } from '../logger.js';

const log = logger.child({ module: 'migrate' });

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');
const PG_LOCK_KEY = 0x6f7a7731; // arbitrary but stable app-wide key ('ozw1')
const MYSQL_LOCK_NAME = 'ozwell-studio-launcher.migrations';
const LOCK_TIMEOUT_S = 60;

/** Run all pending migrations, serialized across instances when possible. */
export async function migrate(sequelize) {
  const dialect = sequelize.getDialect();
  if (dialect === 'sqlite') {
    return runPending(sequelize, null);
  }
  // A transaction pins one connection, so session-scoped locks
  // (GET_LOCK) and xact-scoped locks (pg) both behave.
  return sequelize.transaction(async (transaction) => {
    await acquireLock(sequelize, dialect, transaction);
    try {
      await runPending(sequelize, transaction);
    } finally {
      await releaseLock(sequelize, dialect, transaction);
    }
  });
}

async function acquireLock(sequelize, dialect, transaction) {
  if (dialect === 'postgres') {
    // Released automatically when the transaction ends.
    await sequelize.query(`SELECT pg_advisory_xact_lock(${PG_LOCK_KEY})`, { transaction });
    return;
  }
  if (dialect === 'mysql' || dialect === 'mariadb') {
    const [[row]] = await sequelize.query(
      `SELECT GET_LOCK('${MYSQL_LOCK_NAME}', ${LOCK_TIMEOUT_S}) AS locked`,
      { transaction }
    );
    if (Number(row.locked) !== 1) {
      throw new Error('Timed out waiting for the migration advisory lock.');
    }
    return;
  }
  log.warn(`no advisory lock support for dialect "${dialect}"; migrating without one`);
}

async function releaseLock(sequelize, dialect, transaction) {
  if (dialect === 'mysql' || dialect === 'mariadb') {
    await sequelize.query(`SELECT RELEASE_LOCK('${MYSQL_LOCK_NAME}')`, { transaction });
  }
  // postgres xact locks release with the transaction; nothing to do.
}

async function runPending(sequelize, transaction) {
  const queryInterface = sequelize.getQueryInterface();

  // v6 createTable emits CREATE TABLE IF NOT EXISTS, so this is idempotent.
  await queryInterface.createTable(
    'migrations',
    {
      name: { type: DataTypes.STRING, primaryKey: true },
      appliedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { transaction }
  );

  const applied = new Set(
    (
      await sequelize.query('SELECT name FROM migrations', {
        type: QueryTypes.SELECT,
        transaction,
      })
    ).map((row) => row.name)
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    if (!/^\d{14}-.+\.js$/.test(file)) {
      throw new Error(`Migration "${file}" must be named YYYYMMDDHHmmSS-description.js`);
    }
  }
  for (const file of files) {
    if (applied.has(file)) continue;
    log.info(`applying migration ${file}`);
    const { up } = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)));
    await up(queryInterface, DataTypes, transaction);
    await queryInterface.bulkInsert('migrations', [{ name: file, appliedAt: new Date() }], {
      transaction,
    });
  }
}

/**
 * Database wiring, following Sequelize's standard layout: one Sequelize
 * instance from SQL_URI, with every model in models/ loaded dynamically
 * and re-exported by model name (plus an `associate(models)` hook, should
 * a model ever need relations).
 *
 * SQLite is the bundled default (via @vscode/sqlite3 — the original
 * sqlite3 module is unmaintained); any other Sequelize dialect works when
 * its driver package is installed.
 *
 * Local state is deliberately minimal: the manager owns all container
 * data. This database only remembers which pre-built studios are waiting
 * in the pool, so the pool survives restarts.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Sequelize, DataTypes } from 'sequelize';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'db' });

/** @vscode/sqlite3 is CJS; Sequelize's sqlite dialect calls .verbose() on it. */
const dialectModule = config.sqlUri.startsWith('sqlite')
  ? (await import('@vscode/sqlite3')).default
  : undefined;

export const sequelize = new Sequelize(config.sqlUri, {
  logging: (sql) => log.debug(sql),
  dialectModule,
});

/** All models from models/, keyed by model name. */
export const models = {};

const MODELS_DIR = path.join(import.meta.dirname, 'models');
for (const file of (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.js')).sort()) {
  const { default: define } = await import(pathToFileURL(path.join(MODELS_DIR, file)));
  const model = define(sequelize, DataTypes);
  models[model.name] = model;
}
for (const model of Object.values(models)) {
  model.associate?.(models);
}

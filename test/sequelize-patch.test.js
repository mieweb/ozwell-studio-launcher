/**
 * Pins the patch-package fix for sequelize's sqlite describeTable
 * (patches/sequelize+*.patch, a v6 backport of sequelize/sequelize#17583):
 * columns covered by a multi-column unique index must NOT be reported as
 * individually unique, otherwise sqlite table rebuilds (addColumn /
 * changeColumn / removeColumn) bake a bogus UNIQUE constraint onto each
 * member column — the "erroneous UNIQUE on Containers.nodeId" bug.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DataTypes } from 'sequelize';

process.env.SQL_URI = 'sqlite::memory:';
process.env.LOG_LEVEL = 'warn';

const { sequelize } = await import('../src/db/index.js');
const queryInterface = sequelize.getQueryInterface();

before(async () => {
  await queryInterface.createTable('patch_probe', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    a: { type: DataTypes.STRING, allowNull: false },
    b: { type: DataTypes.STRING, allowNull: false },
    solo: { type: DataTypes.STRING, unique: true },
  });
  await queryInterface.addIndex('patch_probe', ['a', 'b'], { unique: true });
});

test('multi-column unique indexes do not mark member columns unique', async () => {
  const table = await queryInterface.describeTable('patch_probe');
  assert.equal(table.a.unique, false, 'a is only unique together with b');
  assert.equal(table.b.unique, false, 'b is only unique together with a');
});

test('single-column unique constraints are still detected', async () => {
  const table = await queryInterface.describeTable('patch_probe');
  assert.equal(table.solo.unique, true);
});

test('a table rebuild (addColumn) preserves the index shape', async () => {
  await queryInterface.addColumn('patch_probe', 'extra', {
    type: DataTypes.STRING,
    allowNull: true,
  });
  const table = await queryInterface.describeTable('patch_probe');
  assert.equal(table.a.unique, false, 'rebuild must not bake UNIQUE onto a');
  assert.equal(table.b.unique, false, 'rebuild must not bake UNIQUE onto b');
  assert.equal(table.solo.unique, true, 'rebuild must keep the real UNIQUE');
});

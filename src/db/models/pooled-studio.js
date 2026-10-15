/**
 * A pre-built studio waiting to be claimed. Only the hostname is stored;
 * everything else is queried from the manager. FIFO order comes from the
 * autoincrement id.
 */
export default (sequelize, DataTypes) =>
  sequelize.define(
    'PooledStudio',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      hostname: { type: DataTypes.STRING, allowNull: false, unique: true },
    },
    { tableName: 'pooled_studios', updatedAt: false }
  );

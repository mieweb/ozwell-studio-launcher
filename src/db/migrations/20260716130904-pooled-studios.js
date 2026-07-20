/** The pool table: hostnames of pre-built studios, FIFO by id. */
export async function up(queryInterface, DataTypes, transaction) {
  await queryInterface.createTable(
    'pooled_studios',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      hostname: { type: DataTypes.STRING, allowNull: false, unique: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { transaction }
  );
}

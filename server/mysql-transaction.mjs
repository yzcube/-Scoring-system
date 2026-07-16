export async function withMysqlConsistentSnapshot(connection, read) {
  let transactionStarted = false;
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT");
    transactionStarted = true;
    const result = await read();
    await connection.commit();
    return result;
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    throw error;
  }
}

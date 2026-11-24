'use strict';

// NWP-PRICE-010: database access for the Price updater.
//
// Reuses the engine's connection module (src/types/engine/database.js): same credentials
// (DATABASE_URL locally, DATABASE_SECRET_ARN in Lambda), same RDS certificate handling and pool settings,
// so there is no third copy of that logic. It is loaded lazily, so pricing modules and their tests can be
// required without the `pg` package or a database.

function loadDatabase() {
  // eslint-disable-next-line global-require
  return require('../types/engine/database');
}

async function getPool() {
  return loadDatabase().getPool();
}

async function closePool() {
  return loadDatabase().closePool();
}

/**
 * Runs `work(client)` inside one transaction: COMMIT when it resolves, ROLLBACK when it throws (the error
 * is re-thrown). The client is always released.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} work
 * @param {{ pool?: { connect: () => Promise<any> } }} [options]  inject a pool (tests); default getPool()
 * @returns {Promise<T>}
 */
async function withTransaction(work, { pool } = {}) {
  if (typeof work !== 'function') throw new TypeError('withTransaction: work must be a function.');
  const activePool = pool || await getPool();
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('pricing db: rollback failed', rollbackError && rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  closePool,
  withTransaction,
};

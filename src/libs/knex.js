import Knex from 'knex';
import knexConfigs from '../configs/knex.config.js';
import config from '../configs/variables.config.js';

const options =
  config.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;

const db = Knex(options);

export const closeDb = () => db.destroy();

/**
 * Unit of work across several repositories.
 *
 * A transaction has to start somewhere above the repository layer, but that is
 * the only thing a service needs — handing it `db` invites a query to be built
 * there too, which is exactly how Knex leaks out of the repositories. The `trx`
 * passed to `fn` is only ever forwarded to repository methods.
 */
export const withTransaction = (fn) => db.transaction(fn);

export default db;

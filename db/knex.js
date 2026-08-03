import Knex from 'knex';
import knexConfigs from '../src/configs/knex.config.js';
import config from '../src/configs/variables.config.js';

/**
 * One Knex instance per process, alongside the Redis client in redis.js.
 * Repositories import this; nothing else should touch the database directly.
 */
const options =
  config.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;

const db = Knex(options);

export const closeDb = () => db.destroy();

export default db;

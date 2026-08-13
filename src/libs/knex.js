import Knex from 'knex';
import knexConfigs from '../configs/knex.config.js';
import config from '../configs/variables.config.js';

const options =
  config.NODE_ENV === 'production' ? knexConfigs.production : knexConfigs.development;

const db = Knex(options);

export const closeDb = () => db.destroy();

export default db;

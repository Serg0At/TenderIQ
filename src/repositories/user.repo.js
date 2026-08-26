import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'users';

export default class UserRepository {
  /** Email is the login identity, so lookups normalise case the same way inserts do. */
  static async findByEmail(email, trx = db) {
    return trx(TABLE).whereRaw('lower(email) = ?', [String(email).toLowerCase()]).first();
  }

  static async findById(id, trx = db) {
    return trx(TABLE).where({ id }).first();
  }

  static async create({ email, passwordHash, locale = 'hy' }, trx = db) {
    const id = createId();
    await trx(TABLE).insert({
      id,
      email: String(email).toLowerCase(),
      password_hash: passwordHash,
      locale,
    });
    return id;
  }
}

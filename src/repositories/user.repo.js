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

  /**
   * A new account is always unverified: `email_verified_at` is left NULL and
   * only `markEmailVerified` ever sets it. Defaulting it to now() here would
   * make the column say "confirmed" about an address nobody has answered.
   */
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

  /**
   * Confirm the address.
   *
   * Idempotent by omission: a second confirmation of an already-verified
   * account updates zero rows and reports false, so a user who clicks the link
   * twice is told "already confirmed" instead of having their verification
   * timestamp quietly reset to the second click.
   */
  static async markEmailVerified(id, trx = db) {
    const updated = await trx(TABLE)
      .where({ id })
      .whereNull('email_verified_at')
      .update({ email_verified_at: trx.fn.now() });
    return updated > 0;
  }

  /**
   * Set a new password hash.
   *
   * Callers must revoke the user's refresh families alongside this — a password
   * change that leaves existing sessions alive is a reset that does not lock
   * out whoever prompted it.
   */
  static async updatePassword(id, passwordHash, trx = db) {
    const updated = await trx(TABLE).where({ id }).update({ password_hash: passwordHash });
    return updated > 0;
  }
}

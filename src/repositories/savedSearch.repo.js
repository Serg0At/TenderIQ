import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'saved_searches';

/**
 * Alert profiles, scoped to an organization.
 *
 * Every method takes the organization id and applies it in the WHERE clause —
 * tenant isolation is a repository responsibility, not something a caller can
 * forget. A method that accepted only a row id would be one missing check away
 * from cross-tenant reads.
 */
export default class SavedSearchRepository {
  static async listForOrg(organizationId, trx = db) {
    return trx(TABLE).where({ organization_id: organizationId }).orderBy('created_at', 'desc');
  }

  static async findForOrg(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).first();
  }

  static async create(organizationId, profile, trx = db) {
    const id = createId();
    await trx(TABLE).insert({
      id,
      organization_id: organizationId,
      name: profile.name,
      cpv_codes: profile.cpvCodes ?? [],
      keywords: profile.keywords ?? [],
      regions: profile.regions ?? [],
      min_value: profile.minValue ?? null,
      max_value: profile.maxValue ?? null,
      channels: profile.channels ?? [],
    });
    return trx(TABLE).where({ id }).first();
  }

  static async update(id, organizationId, profile, trx = db) {
    const patch = {
      ...(profile.name !== undefined ? { name: profile.name } : {}),
      ...(profile.cpvCodes !== undefined ? { cpv_codes: profile.cpvCodes } : {}),
      ...(profile.keywords !== undefined ? { keywords: profile.keywords } : {}),
      ...(profile.regions !== undefined ? { regions: profile.regions } : {}),
      ...(profile.minValue !== undefined ? { min_value: profile.minValue } : {}),
      ...(profile.maxValue !== undefined ? { max_value: profile.maxValue } : {}),
      ...(profile.channels !== undefined ? { channels: profile.channels } : {}),
      updated_at: new Date(),
    };
    const updated = await trx(TABLE).where({ id, organization_id: organizationId }).update(patch);
    return updated ? trx(TABLE).where({ id }).first() : null;
  }

  static async remove(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).del();
  }

  /** Every profile in the system — the matcher's input on each ingest event. */
  static async listAll(trx = db) {
    return trx(TABLE).select('*');
  }
}

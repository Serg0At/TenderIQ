import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'supplier_identities';

/**
 * The parties an organization bids as (ticket 32), scoped to that
 * organization.
 *
 * Every method takes the organization id and applies it in the WHERE clause,
 * as every private repository does — except `holderOf`, which answers the one
 * cross-tenant question the claim has to ask (is this party someone else's?)
 * and returns only whether it is, never whose.
 */
export default class SupplierIdentityRepository {
  /** The claims, with what the picker showed for each party, oldest first. */
  static async listForOrg(organizationId, trx = db) {
    return trx(`${TABLE} as s`)
      .join('parties as p', 'p.id', 's.party_id')
      .where('s.organization_id', organizationId)
      .orderBy([{ column: 's.claimed_at' }, { column: 's.id' }])
      .select('s.party_id', 'p.name', 'p.tax_id', 'p.region', 's.claimed_at');
  }

  /** Just the party ids — what reconciliation and relevance read. */
  static async partyIdsFor(organizationId, trx = db) {
    const rows = await trx(TABLE).where({ organization_id: organizationId }).orderBy('party_id').select('party_id');
    return rows.map((row) => row.party_id);
  }

  static async countForOrg(organizationId, trx = db) {
    const row = await trx(TABLE).where({ organization_id: organizationId }).count('* as n').first();
    return Number(row.n);
  }

  /**
   * Claim one party. The unique index on `party_id` arbitrates two
   * organizations claiming it at once, so this reports a lost race instead of
   * throwing: `false` means the party is already claimed, by this organization
   * or another (`holderOf` says which).
   */
  static async add(organizationId, partyId, claimedBy = null, trx = db) {
    const inserted = await trx(TABLE)
      .insert({ id: createId(), organization_id: organizationId, party_id: partyId, claimed_by: claimedBy })
      .onConflict('party_id')
      .ignore();
    return (inserted?.rowCount ?? 0) > 0;
  }

  /** Whether `partyId` is claimed by this organization, by another, or by none. */
  static async holderOf(partyId, organizationId, trx = db) {
    const row = await trx(TABLE).where({ party_id: partyId }).first('organization_id');
    if (!row) return 'none';
    return row.organization_id === organizationId ? 'self' : 'other';
  }

  static async remove(organizationId, partyId, trx = db) {
    return trx(TABLE).where({ organization_id: organizationId, party_id: partyId }).del();
  }
}

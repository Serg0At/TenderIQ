import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { sha256 } from '../utils/hash.js';

const TABLE = 'parties';

/** Trailing punctuation and quote styles vary run to run; the entity does not. */
const normalizeName = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^["'«]+|["'»]+$/g, '')
    .trim();

/**
 * Every party gets a deterministic `source_id`, which turns identity into a
 * database uniqueness problem rather than an application-logic one — the same
 * choice `source_payloads` makes.
 *
 * Suppliers carry a real one: the bidder link exposes a stable ARMEPS business
 * operator id (verified — seven suppliers, one id each, constant across all
 * lots of a tender). Buyers are rendered as bare text with no link at all, so
 * theirs is derived from the normalized name. That means a buyer renaming
 * itself creates a second row; the alternative is fuzzy-matching organisation
 * names, which silently merges distinct entities and is far worse.
 */
export const buyerSourceId = (source, name) =>
  `${source}:buyer:${sha256(normalizeName(name).toLowerCase()).slice(0, 16)}`;

export const supplierSourceId = (source, sourceId) => `${source}:bo:${sourceId}`;

export default class PartyRepository {
  /**
   * Insert or widen a party, keyed on `source_id`.
   *
   * `role` widens to 'both' rather than overwriting: an organisation that buys
   * in one tender and supplies in another must not flip-flop on every ingest.
   * Because the widening decision needs the stored row, this reads first and
   * relies on the unique constraint to arbitrate the concurrent-insert race.
   */
  static async upsert({ sourceId, name, role, taxId = null, region = null }, trx = db) {
    const cleanName = normalizeName(name);
    if (!sourceId || !cleanName) return null;

    const existing = await trx(TABLE).where({ source_id: sourceId }).first();

    if (existing) {
      const patch = {};
      if (existing.role !== role && existing.role !== 'both') patch.role = 'both';
      if (cleanName !== existing.name) patch.name = cleanName;
      if (taxId && !existing.tax_id) patch.tax_id = taxId;
      if (region && !existing.region) patch.region = region;
      if (Object.keys(patch).length) await trx(TABLE).where({ id: existing.id }).update(patch);
      return existing.id;
    }

    const id = createId();
    const [row] = await trx(TABLE)
      .insert({ id, source_id: sourceId, name: cleanName, tax_id: taxId, role, region })
      .onConflict('source_id')
      .merge({ name: cleanName })
      .returning('id');

    return row?.id ?? id;
  }

  static async upsertBuyer({ source, name, taxId = null, region = null }, trx = db) {
    if (!normalizeName(name)) return null;
    return PartyRepository.upsert(
      { sourceId: buyerSourceId(source, name), name, role: 'buyer', taxId, region },
      trx
    );
  }

  static async upsertSupplier({ source, sourceId, name }, trx = db) {
    if (!sourceId || !normalizeName(name)) return null;
    return PartyRepository.upsert(
      { sourceId: supplierSourceId(source, sourceId), name, role: 'supplier' },
      trx
    );
  }

  /**
   * Fill in a tax ID discovered later, from the invitation archive.
   *
   * Only ever fills a blank — never overwrites. A tax ID already on the row
   * came from somewhere, and a parse slip must not silently replace a party's
   * legal identifier.
   */
  static async setTaxId(partyId, taxId, trx = db) {
    if (!partyId || !taxId) return false;
    const updated = await trx(TABLE).where({ id: partyId }).whereNull('tax_id').update({ tax_id: taxId });
    return updated > 0;
  }

  static async findBySourceId(sourceId, trx = db) {
    return trx(TABLE).where({ source_id: sourceId }).first();
  }

  static async countByRole(role, trx = db) {
    const row = await trx(TABLE).where({ role }).count('* as c').first();
    return Number(row.c);
  }
}

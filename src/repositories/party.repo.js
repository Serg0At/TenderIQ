import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';
import { sha256 } from '../utils/hash.js';

const TABLE = 'parties';

/**
 * A party's name as the source publishes it, whitespace collapsed and nothing
 * else. The guillemets are part of an Armenian legal name — «Երևանի ավտոբուս»
 * ՓԲԸ — and usually sit in the middle of it, so stripping a leading « and a
 * trailing » (which this once did, to unwrap names quoted whole) cut one half
 * of the pair and stored `Երևանի ավտոբուս» ՓԲԸ`.
 */
const normalizeName = (raw) => String(raw ?? '').trim().replace(/\s+/g, ' ');

/** Every quotation mark the source has been seen to use, in any style. */
const QUOTES = /["'«»„“”‘’]/g;

/**
 * What a buyer's identity is derived from: the name with every quotation mark
 * removed, lowercased. Quoting is how a name is typeset, not which entity it
 * names, so `«X» ՓԲԸ`, `"X" ՓԲԸ` and the half-stripped `X» ՓԲԸ` stored before
 * the fix above are all one buyer.
 */
export const identityKey = (raw) => normalizeName(String(raw ?? '').replace(QUOTES, '')).toLowerCase();

/**
 * Every party gets a deterministic `source_id`, which turns identity into a
 * database uniqueness problem rather than an application-logic one — the same
 * choice `source_payloads` makes.
 *
 * Suppliers carry a real one: the bidder link exposes a stable e-auction business
 * operator id (verified — seven suppliers, one id each, constant across all
 * lots of a tender). Buyers are rendered as bare text with no link at all, so
 * theirs is derived from the normalized name. That means a buyer renaming
 * itself creates a second row; the alternative is fuzzy-matching organisation
 * names, which silently merges distinct entities and is far worse.
 */
export const buyerSourceId = (source, name) =>
  `${source}:buyer:${sha256(identityKey(name)).slice(0, 16)}`;

export const supplierSourceId = (source, sourceId) => `${source}:bo:${sourceId}`;

export default class PartyRepository {
  /**
   * Insert or widen a party: by ՀՎՀՀ first, by `source_id` second (ticket 11).
   *
   * The ՀՎՀՀ is the only structural identifier a company has across sources,
   * so a bidder that states one reuses the party already holding it — the
   * e-auction party a PPCM ledger row gave it, say — instead of becoming a
   * second party for the same company. Only when exactly one party holds it:
   * two holders are a duplicate to report (BidderTaxIdService), not to
   * choose between, and fall back to the per-source id like a bidder with no
   * ՀՎՀՀ. Only a party of the same role, or `both`: a supplier is never
   * folded into a buyer row by its ՀՎՀՀ here — whether a buyer and a bidder
   * holding one ՀՎՀՀ are one party is ticket 19's decision, and a branch can
   * carry its parent's (two buyers hold 01506928). Until then the pair is two
   * rows, reported like any other.
   *
   * `role` widens to 'both' rather than overwriting: an organisation that buys
   * in one tender and supplies in another must not flip-flop on every ingest.
   * The name is the party's own source's: a party reached by its ՀՎՀՀ from
   * another source keeps it, or two sources' spellings would trade places on
   * every ingest. Because the widening decision needs the stored row, this
   * reads first and relies on the unique constraint to arbitrate the
   * concurrent-insert race.
   */
  static async upsert({ sourceId, name, role, taxId = null, region = null }, trx = db) {
    const cleanName = normalizeName(name);
    if (!sourceId || !cleanName) return null;

    const holders = taxId ? await trx(TABLE).where({ tax_id: taxId }).whereIn('role', [role, 'both']).limit(2) : [];
    const existing = holders.length === 1 ? holders[0] : await trx(TABLE).where({ source_id: sourceId }).first();

    if (existing) {
      const patch = {};
      if (existing.role !== role && existing.role !== 'both') patch.role = 'both';
      if (existing.source_id === sourceId && cleanName !== existing.name) patch.name = cleanName;
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

  /**
   * `taxId` is the bidder's ՀՎՀՀ where its source states one (PPCM, ticket
   * 10), and it decides the party before the per-source id does (`upsert`).
   * Like every `upsert` field it only fills a blank.
   */
  static async upsertSupplier({ source, sourceId, name, taxId = null }, trx = db) {
    if (!sourceId || !normalizeName(name)) return null;
    return PartyRepository.upsert(
      { sourceId: supplierSourceId(source, sourceId), name, role: 'supplier', taxId },
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

  /**
   * Re-derive every buyer's `source_id` from its stored name, for when the
   * identity rule itself changes. Without it, the next ingest of a buyer whose
   * key moved would create a second row and split its tenders across two.
   *
   * A buyer whose new key already belongs to another row is left alone and
   * reported, not merged: two rows that now look like one entity need a person
   * to decide, and a merge moves every tender, award and profile pointing at it.
   */
  static async rekeyBuyers({ source }, trx = db) {
    const buyers = await trx(TABLE)
      .whereIn('role', ['buyer', 'both'])
      .andWhere('source_id', 'like', `${source}:buyer:%`)
      .select('id', 'source_id', 'name');

    const rekeyed = [];
    const collisions = [];
    for (const buyer of buyers) {
      const next = buyerSourceId(source, buyer.name);
      if (next === buyer.source_id) continue;
      const taken = await trx(TABLE).where({ source_id: next }).first('id');
      if (taken) {
        collisions.push({ id: buyer.id, name: buyer.name, holder: taken.id });
        continue;
      }
      await trx(TABLE).where({ id: buyer.id }).update({ source_id: next });
      rekeyed.push(buyer.id);
    }
    return { checked: buyers.length, rekeyed: rekeyed.length, collisions };
  }

  /** Every party holding one ՀՎՀՀ — one, normally; more is a duplicate to report. */
  static async holdersOfTaxId(taxId, trx = db) {
    if (!taxId) return [];
    return trx(TABLE).where({ tax_id: taxId }).orderBy('id').select('id', 'source_id', 'name', 'role');
  }

  static async findBySourceId(sourceId, trx = db) {
    return trx(TABLE).where({ source_id: sourceId }).first();
  }

  /**
   * One party by internal id — the lookup the profile endpoints use to decide
   * existence before computing anything.
   *
   * `role` is checked by the caller rather than filtered here: a party that
   * buys in one tender and supplies in another is stored as 'both', so
   * filtering on an exact role in SQL would 404 a real supplier purely because
   * it also happens to buy.
   */
  static async findById(id, trx = db) {
    if (!id) return null;
    return trx(TABLE).where({ id }).first();
  }

  /**
   * Find a supplier by name, so an organisation can claim its own identity.
   *
   * Search rather than auto-match on purpose. Party names here are scraped
   * Armenian legal names with inconsistent quoting ("ՍՊԸ" vs «ՍՊԸ»), and a
   * fuzzy auto-link would eventually attach one company's win record to
   * another company's account — a failure nobody would see, because the numbers
   * would simply be wrong rather than missing. A human picks from this list.
   *
   * `bid_count` is what makes the list usable: several parties can share a
   * trading name, and the one with 40 bids is almost always the one meant.
   */
  static async searchSuppliers({ query, limit = 20 }, trx = db) {
    const like = `%${String(query).trim()}%`;
    return trx(`${TABLE} as p`)
      .leftJoin('public_tender_bids as b', 'b.supplier_id', 'p.id')
      .whereIn('p.role', ['supplier', 'both'])
      .andWhere((q) => q.whereILike('p.name', like).orWhere('p.tax_id', String(query).trim()))
      .groupBy('p.id', 'p.name', 'p.tax_id', 'p.region')
      .select('p.id', 'p.name', 'p.tax_id', 'p.region')
      .count('b.id as bid_count')
      .orderBy('bid_count', 'desc')
      .limit(limit);
  }

  static async countByRole(role, trx = db) {
    const row = await trx(TABLE).where({ role }).count('* as c').first();
    return Number(row.c);
  }
}

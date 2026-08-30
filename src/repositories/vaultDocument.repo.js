import { createId } from '@paralleldrive/cuid2';
import db from '../libs/knex.js';

const TABLE = 'vault_documents';

/**
 * An organisation's reusable certificates and licences.
 *
 * The most private table in the system: a vault holds a company's tax
 * clearance, bank references and licences, and it is the one place where a
 * cross-tenant read would leak documents rather than merely facts. So every
 * method takes the organisation id and applies it in the WHERE clause — never
 * the caller, and never a method that accepts only a row id.
 *
 * A row is never the file. It points at an object key, and the bytes only exist
 * once `status` is `ready` — see `confirm()`.
 */

const encodeCursor = (row) =>
  Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');

const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return id && at ? { createdAt: at, id } : null;
  } catch {
    return null;
  }
};

export default class VaultDocumentRepository {
  /**
   * One page of the vault.
   *
   * `pending` and `rejected` rows are excluded unless asked for: an upload that
   * was registered and abandoned has no file behind it, and listing it would
   * put an undownloadable document in front of someone about to attach it to a
   * bid.
   */
  static async listForOrg(
    organizationId,
    { kind = null, status = 'ready', limit = 20, cursor = null } = {},
    trx = db
  ) {
    const query = trx(TABLE).where({ organization_id: organizationId });

    if (status) query.whereIn('status', Array.isArray(status) ? status : [status]);
    if (kind) query.whereIn('kind', Array.isArray(kind) ? kind : [kind]);

    const after = decodeCursor(cursor);
    if (after) query.whereRaw('(created_at, id) < (?, ?)', [after.createdAt, after.id]);

    // One extra row answers "is there a next page?" without a second COUNT.
    const rows = await query
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      rows: page,
      hasMore: rows.length > limit,
      cursor: page.length ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  static async findRow(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).first();
  }

  /** Used by the dedupe path: has this organisation already got these exact bytes? */
  static async findByHash(organizationId, hash, trx = db) {
    return trx(TABLE).where({ organization_id: organizationId, hash }).first();
  }

  /**
   * Reserve a row for an upload that has not happened yet.
   *
   * `status: 'pending'` is the whole point — the presigned PUT goes straight
   * from the client to object storage, so this process never observes the write
   * and cannot know it succeeded until `confirm()` looks.
   *
   * The (organization_id, hash) unique index arbitrates a double-click: the
   * database decides, not a read-then-write that both clicks would pass. A
   * conflict returns the existing row, which the service reads as "you already
   * have this document" rather than an error.
   */
  static async register(
    {
      organizationId,
      kind,
      hash,
      storageKey,
      filename,
      contentType,
      sizeBytes,
      validUntil = null,
      issuedAt = null,
      notes = null,
      uploadedByUserId = null,
    },
    trx = db
  ) {
    const id = createId();
    const inserted = await trx(TABLE)
      .insert({
        id,
        organization_id: organizationId,
        kind,
        hash,
        storage_key: storageKey,
        filename,
        content_type: contentType,
        size_bytes: sizeBytes,
        valid_until: validUntil,
        issued_at: issuedAt,
        notes,
        uploaded_by_user_id: uploadedByUserId,
        status: 'pending',
      })
      .onConflict(['organization_id', 'hash'])
      .ignore()
      .returning('*');

    if (inserted.length) return { created: true, row: inserted[0] };
    return { created: false, row: await this.findByHash(organizationId, hash, trx) };
  }

  /**
   * Mark a registered upload as real, recording the size storage actually
   * reports rather than the one the client declared.
   */
  static async confirm({ id, organizationId, sizeBytes }, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId })
      .update({ status: 'ready', size_bytes: sizeBytes, updated_at: new Date() });
    return updated ? this.findRow(id, organizationId, trx) : null;
  }

  static async reject({ id, organizationId, reason }, trx = db) {
    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId })
      .update({ status: 'rejected', notes: reason, updated_at: new Date() });
    return updated ? this.findRow(id, organizationId, trx) : null;
  }

  /**
   * Edit the metadata, never the bytes.
   *
   * `hash` and `storage_key` are not patchable by design: they identify the
   * file, and letting them move would let a row claim a document it does not
   * hold. A replacement document is a new upload — which is also what keeps the
   * expired original visible as history.
   */
  static async update(id, organizationId, patch, trx = db) {
    const next = {
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.filename !== undefined ? { filename: patch.filename } : {}),
      ...(patch.validUntil !== undefined ? { valid_until: patch.validUntil } : {}),
      ...(patch.issuedAt !== undefined ? { issued_at: patch.issuedAt } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    };
    if (!Object.keys(next).length) return this.findRow(id, organizationId, trx);

    const updated = await trx(TABLE)
      .where({ id, organization_id: organizationId })
      .update({ ...next, updated_at: new Date() });
    return updated ? this.findRow(id, organizationId, trx) : null;
  }

  static async remove(id, organizationId, trx = db) {
    return trx(TABLE).where({ id, organization_id: organizationId }).del();
  }

  /**
   * Documents crossing an expiry threshold, for the daily sweep.
   *
   * The window is half-open on both ends — `(from, until]` — so consecutive
   * thresholds cannot both claim the same document on the same run. Widest
   * threshold first (the config sorts descending), and each writes its own
   * notification type, so a certificate 30 days out is warned about once at 30,
   * once at 7 and once at 1 rather than three times today.
   *
   * Cross-tenant by design: this is a scheduled sweep over every organisation,
   * which is why it returns `organization_id` on every row and why nothing here
   * is reachable from an HTTP handler.
   */
  static async dueForExpiryWarning({ from, until }, trx = db) {
    return trx(TABLE)
      .where('status', 'ready')
      .whereNotNull('valid_until')
      .andWhere('valid_until', '>', from)
      .andWhere('valid_until', '<=', until)
      .select(
        'id',
        'organization_id',
        'kind',
        'filename',
        'valid_until',
        'hash'
      );
  }

  /** Documents whose validity has already lapsed and that have not been warned about as expired. */
  static async expired({ asOf = new Date() } = {}, trx = db) {
    return trx(TABLE)
      .where('status', 'ready')
      .whereNotNull('valid_until')
      .andWhere('valid_until', '<=', asOf)
      .select('id', 'organization_id', 'kind', 'filename', 'valid_until');
  }

  /**
   * Registered uploads whose bytes never arrived.
   *
   * Pruned rather than left to accumulate: a pending row holds the
   * (organization_id, hash) slot, so an abandoned upload would block a later
   * genuine one of the same document with a conflict the customer cannot
   * explain.
   */
  static async prunePending({ olderThan }, trx = db) {
    return trx(TABLE).where('status', 'pending').andWhere('created_at', '<', olderThan).del();
  }

  /** Vault contents by kind, for the summary the document list is headed with. */
  static async summaryForOrg(organizationId, { asOf = new Date() } = {}, trx = db) {
    const rows = await trx(TABLE)
      .where({ organization_id: organizationId, status: 'ready' })
      .select('kind')
      .count({ total: '*' })
      .select(
        trx.raw('count(*) filter (where valid_until is not null and valid_until <= ?)::int as expired', [asOf])
      )
      .groupBy('kind')
      .orderBy('kind');
    return rows.map((row) => ({
      kind: row.kind,
      total: Number(row.total),
      expired: Number(row.expired),
    }));
  }
}

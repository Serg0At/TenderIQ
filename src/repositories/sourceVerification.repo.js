import db from '../libs/knex.js';
import { codeKeySql } from './tender.repo.js';
import { SUPERSEDED } from './tenderSource.repo.js';

/** `[from, to)` on one timestamp column; either end may be open. */
const within = (qb, column, { from = null, to = null } = {}) => {
  if (from) qb.where(column, '>=', from);
  if (to) qb.where(column, '<', to);
  return qb;
};

/** A tender's creating link: `tenders.source_id` is that link's `{source}:{external_id}`. */
const creatingLink = (trx) =>
  function onCreatingLink() {
    this.on('t.source_id', '=', trx.raw("s.source || ':' || s.external_id"));
  };

/**
 * The counts `npm run sources:verify` prints (ticket 13): how the merge rules
 * of ADR 0004 came out on real data, per source. Read-only, public data, so no
 * organization scope.
 *
 * Every window is over when Tendra first saw the row (`first_seen_at`), not
 * when the source published it: the question is what ingestion did in that
 * span. A tender is in the window when its creating link is — `tenders.source_id`
 * is that link's `{source}:{external_id}`.
 */
export default class SourceVerificationRepository {
  /**
   * Per source: the tenders it created, the tenders it is linked to, and its
   * links by role. `created` counts creating links, `linked` distinct tenders.
   */
  static async tendersBySource(window, trx = db) {
    const created = await within(
      trx('tender_sources as s')
        .join('tenders as t', creatingLink(trx))
        .groupBy('s.source')
        .select('s.source', trx.raw('count(*)::int as created')),
      's.first_seen_at',
      window
    );
    const links = await within(
      trx('tender_sources')
        .groupBy('source', 'role')
        .orderBy(['source', 'role'])
        .select('source', 'role', trx.raw('count(*)::int as links')),
      'first_seen_at',
      window
    );
    const linked = await within(
      trx('tender_sources').groupBy('source').select('source', trx.raw('count(distinct tender_id)::int as linked')),
      'first_seen_at',
      window
    );
    return { created, links, linked };
  }

  /**
   * Unmatched results per source and reason, split on `was_public` (ticket
   * 31: a miss is `no_candidate` and `was_public` true) and on whether a
   * tender has since taken them.
   */
  static async unmatchedByReason(window, trx = db) {
    return within(
      trx('unmatched_results')
        .groupBy('source', 'reason', 'was_public')
        .orderBy(['source', 'reason', 'was_public'])
        .select(
          'source',
          'reason',
          'was_public',
          trx.raw('count(*) filter (where resolved_at is null)::int as open'),
          trx.raw('count(*) filter (where resolved_at is not null)::int as resolved')
        ),
      'first_seen_at',
      window
    );
  }

  /**
   * The open `unsupported_format` rows by notice kind, procedure and file
   * extension — the counts that choose a converter (ticket 31's split: a
   * single-source contract is a price kept out of every comparison, so it
   * should not choose one). The extension is the stored payload's, one per
   * row however many payload rows share its hash; a row whose payload row is
   * gone is still counted, as `none`.
   */
  static async unreadableFormats(window, trx = db) {
    const rows = within(
      trx('unmatched_results as u')
        .where({ 'u.reason': 'unsupported_format' })
        .whereNull('u.resolved_at')
        .select(
          'u.source',
          trx.raw(`case when u.external_ref like 'contract:%' then 'contract'
                        when u.external_ref like 'failed:%' then 'failed'
                        when u.external_ref like 'amendment:%' then 'amendment'
                        else 'invitation' end as kind`),
          trx.raw(`case when u.procedure_type = 'single_source' then 'single_source'
                        when u.procedure_type is null then 'unknown'
                        else 'competitive' end as procedure`),
          trx.raw(`coalesce((
            select substring(p.storage_key from '\\.([a-z0-9]+)$')
              from source_payloads p
             where p.source = u.source and p.hash = u.payload_hash
               and p.ref in (u.external_ref, 'detail:' || u.external_ref)
             order by p.fetched_at desc
             limit 1
          ), 'none') as ext`)
        ),
      'u.first_seen_at',
      window
    );
    return trx
      .from(rows.as('r'))
      .groupBy('source', 'kind', 'procedure', 'ext')
      .orderBy([{ column: 'source' }, { column: 'kind' }, { column: 'procedure' }, { column: 'n', order: 'desc' }])
      .select('source', 'kind', 'procedure', 'ext', trx.raw('count(*)::int as n'));
  }

  /**
   * Tenders by submission channel and status, the latest version of each. A
   * left join, so a tender whose creating link is missing still counts when
   * no window is asked for.
   */
  static async tendersByChannelStatus(window, trx = db) {
    return within(
      trx('tenders as t')
        .leftJoin('tender_sources as s', creatingLink(trx))
        .where('t.is_latest', true)
        .groupBy('t.submission_channel', 't.status')
        .orderBy(['t.submission_channel', 't.status'])
        .select('t.submission_channel', 't.status', trx.raw('count(*)::int as n')),
      's.first_seen_at',
      window
    );
  }

  /**
   * Paper tenders made from an invitation file, each with whether it holds a
   * lot (ticket 36), its deadline, status, procedure type and publication
   * (ticket 37), and the stored file its fields are read from: the run's
   * current file — a superseded one's lots are never written — newest payload
   * first. A result-only tender (ticket 31) has no file and is not counted:
   * there is no lot table to miss and no deadline it stated.
   *
   * A file's link is the SQL twin of `paperNotice.service.js#isFileLink` —
   * change both — and its payload is under `detail:{hash}` (`workers/paper.js`).
   */
  static async paperFileTenders(window, trx = db) {
    const fileLink = (alias) =>
      `${alias}.tender_id = t.id and ${alias}.source = 'gnumner' and ${alias}.role = 'detail'
         and ${alias}.external_id ~ '^[0-9a-f]{64}$'`;
    const rows = await within(
      trx('tenders as t')
        .join('tender_sources as s', creatingLink(trx))
        .where('t.is_latest', true)
        .andWhere('t.submission_channel', 'paper')
        .whereRaw(`exists (select 1 from tender_sources f where ${fileLink('f')})`)
        .select(
          't.reference_code',
          't.status',
          't.procedure_type',
          't.published_at',
          't.deadline_at',
          trx.raw('exists (select 1 from tender_lots l where l.tender_id = t.id) as has_lots'),
          trx.raw(
            `(select p.storage_key
                from tender_sources f
                join source_payloads p on p.source = f.source and p.ref = 'detail:' || f.external_id
               where ${fileLink('f')} and f.observed_status is distinct from ?
               order by p.fetched_at desc
               limit 1) as storage_key`,
            [SUPERSEDED]
          )
        ),
      's.first_seen_at',
      window
    );
    return rows;
  }

  /**
   * gnumner's e-auction notices (the e-auction listing, ticket 34: `listings`,
   * its slugs) against the e-auction tenders Tendra holds — an independent
   * coverage check, since the eauction board finds them on its own. A `tmid`
   * cannot be mapped to a tid, so a notice is held when an e-auction tender
   * has its code, or — a title naming none, about 7 in 10 — was published in
   * the same second: gnumner states an e-auction's publication to the second,
   * as eauction's own page does (8 of 8 code-less notices on 2026-10-29
   * matched one tender exactly). The time match fails toward "not held": a
   * second's code-less notices are held only while that second holds at least
   * as many e-auction tenders as notices of the listing, so two notices
   * cannot both lean on one tender. Any version, any status, a superseded
   * run's included: the question is whether Tendra ever had it. The
   * comparisons take no index; it is a hand-run count.
   * Returns the counts and the notices not held.
   */
  static async eauctionNoticeCoverage(window, { listings }, trx = db) {
    const rows = await within(
      trx('listing_notices as n')
        .where('n.source', 'gnumner')
        .whereIn('n.listing', listings)
        .orderBy('n.published_at')
        .select(
          'n.external_id',
          'n.procedure_code',
          'n.published_at',
          trx.raw(`exists (
            select 1 from tenders t
             where t.submission_channel = 'eauction'
               and ${codeKeySql('t.reference_code')} = ${codeKeySql('n.procedure_code')}
          ) as held_by_code`),
          trx.raw(
            `(select count(distinct t.source_id) from tenders t
               where t.submission_channel = 'eauction' and t.published_at = n.published_at)
             >= (select count(*) from listing_notices m
                  where m.source = n.source and m.listing = n.listing and m.published_at = n.published_at)
             as held_by_time`
          )
        ),
      'n.first_seen_at',
      window
    );
    const coded = rows.filter((row) => row.procedure_code);
    const uncoded = rows.filter((row) => !row.procedure_code);
    return {
      notices: rows.length,
      coded: coded.length,
      uncoded: uncoded.length,
      heldByCode: coded.filter((row) => row.held_by_code).length,
      heldByTime: uncoded.filter((row) => row.held_by_time).length,
      missing: rows
        .filter((row) => (row.procedure_code ? !row.held_by_code : !row.held_by_time))
        .map((row) => ({ externalId: row.external_id, code: row.procedure_code, publishedAt: row.published_at })),
    };
  }

  /**
   * E-auction bidders, and how many hold a ՀՎՀՀ. eauction's own ledger states
   * none, so every one held came from PPCM (ticket 11). Nothing records when a
   * ՀՎՀՀ was set, so this is all time. `sharedTaxIds`: the ՀՎՀՀ an e-auction
   * bidder holds that another party, of any role, holds too.
   */
  static async eauctionBidderTaxIds(trx = db) {
    const row = await trx('parties')
      .where('source_id', 'like', 'eauction:bo:%')
      .first(trx.raw('count(*)::int as bidders'), trx.raw('count(tax_id)::int as "withTaxId"'));
    const shared = await trx('parties')
      .whereNotNull('tax_id')
      .groupBy('tax_id')
      .havingRaw('count(*) > 1')
      .havingRaw("bool_or(source_id like 'eauction:bo:%')")
      .select('tax_id');
    return { ...row, sharedTaxIds: shared.length };
  }
}

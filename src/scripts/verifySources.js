import { closeDb } from '../libs/knex.js';
import { getStorage } from '../libs/storage/index.js';
import { getSourceConfig } from '../configs/sources.config.js';
import { observeDay, observeProcedures, parseStored, procedureId } from '../libs/adapters/source/ppcm/observation.js';
import { cents, matchTaxIds } from '../services/bidderTaxId.service.js';
import { lookupsFor, resolve } from '../services/resolution.service.js';
import publicBids from '../repositories/publicBid.repo.js';
import sourcePayloads from '../repositories/sourcePayload.repo.js';
import tenders from '../repositories/tender.repo.js';
import verification from '../repositories/sourceVerification.repo.js';

/**
 * Did the merge rules of ADR 0004 hold on real data? The stand-in for a test
 * suite (ticket 13): per source, the tenders it created and linked and the
 * results it could not attach, by reason; the unreadable files by notice kind
 * and extension, which is what chooses a converter; tenders by channel and
 * status; gnumner's e-auction notices against the e-auction tenders held; and
 * PPCM's rows against eauction's own ledger on the e-auctions both hold.
 *
 * The PPCM comparison replays every stored PPCM answer through the production
 * parser and resolution (`observeProcedures`, `resolve`, `matchTaxIds`) — a
 * second copy of those rules would check something that is not shipped. It
 * reads storage and the database and writes nothing.
 *
 * Run by hand; prints numbers; asserts nothing. Not a test.
 *
 * Usage:
 *   node src/scripts/verifySources.js [--from=2026-10-20] [--to=2026-10-28]
 *
 *   --from, --to   the window, [from, to), over when Tendra first saw a row
 *                  (and when a PPCM answer was fetched); default: everything.
 *                  A bare date is midnight UTC.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);

const dateArg = (name) => {
  if (args[name] === undefined) return null;
  const at = new Date(args[name]);
  if (Number.isNaN(at.getTime())) throw new Error(`--${name} is not a date: ${args[name]}`);
  return at;
};

// The order the report prints them in. A source or reason the rows hold and
// these do not name is printed after them, never dropped.
const SOURCES = ['eauction', 'armeps', 'gnumner', 'ppcm'];
const REASONS = ['no_candidate', 'ambiguous', 'no_code', 'unsupported_format'];
const inOrder = (known, seen) => [...known, ...[...new Set(seen)].filter((value) => !known.includes(value))];

const pad = (value, width) => String(value).padStart(width);
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const publicLabel = (value) => (value === true ? 'public' : value === false ? 'never public' : 'unknown');

/** Rows grouped on one field, in the order the rows first name each value. */
const groupsOf = (rows, field) => {
  const groups = new Map();
  for (const row of rows) groups.set(row[field], [...(groups.get(row[field]) ?? []), row]);
  return [...groups.entries()];
};

const count = (counts, key, n = 1) => {
  counts[key] = (counts[key] ?? 0) + n;
};

const printSources = async (window) => {
  const { created, links, linked } = await verification.tendersBySource(window);
  const unmatched = await verification.unmatchedByReason(window);

  console.log('— per source —');
  const seen = [...created, ...linked, ...links, ...unmatched].map((row) => row.source);
  for (const source of inOrder(SOURCES, seen)) {
    const made = created.find((row) => row.source === source)?.created ?? 0;
    const tenderCount = linked.find((row) => row.source === source)?.linked ?? 0;
    const roles = links.filter((row) => row.source === source).map((row) => `${row.links} ${row.role}`);
    console.log(`  ${source}: created ${made} tenders, linked to ${tenderCount} (links: ${roles.join(', ') || 'none'})`);

    const rows = unmatched.filter((row) => row.source === source);
    for (const reason of inOrder(REASONS, rows.map((row) => row.reason))) {
      const ofReason = rows.filter((row) => row.reason === reason);
      const open = sum(ofReason, 'open');
      const resolved = sum(ofReason, 'resolved');
      if (!open && !resolved) continue;
      const split = ofReason.filter((row) => row.open).map((row) => `${row.open} ${publicLabel(row.was_public)}`);
      console.log(`    unmatched ${reason.padEnd(18)} ${pad(open, 5)} open (${split.join(', ')})` +
        (resolved ? `, ${resolved} since taken by a tender` : ''));
    }
    // The operator alert's row (ticket 31): a procedure that was public and
    // that Tendra holds no tender for.
    const missed = rows.find((row) => row.reason === 'no_candidate' && row.was_public === true)?.open ?? 0;
    if (rows.length) console.log(`    missed tenders (no_candidate, public): ${missed}`);
  }
  console.log('');
};

const printFormats = async (window) => {
  const rows = await verification.unreadableFormats(window);
  console.log('— unsupported_format, open, by notice kind × procedure × extension —');
  if (!rows.length) console.log('  none');
  for (const [kind, ofKind] of groupsOf(rows, 'kind')) {
    console.log(`  ${kind} (${sum(ofKind, 'n')})`);
    for (const [procedure, cells] of groupsOf(ofKind, 'procedure')) {
      console.log(`    ${procedure.padEnd(14)} ${pad(sum(cells, 'n'), 3)}: ${cells.map((row) => `${row.ext} ${row.n}`).join(', ')}`);
    }
  }
  // What a converter would unlock, across every kind: the extension totals,
  // with the single-source rows apart, since their prices never reach a
  // comparison.
  const byExt = new Map();
  for (const row of rows) {
    const entry = byExt.get(row.ext) ?? { all: 0, competitive: 0 };
    entry.all += row.n;
    if (row.procedure !== 'single_source') entry.competitive += row.n;
    byExt.set(row.ext, entry);
  }
  const totals = [...byExt.entries()].sort(([, a], [, b]) => b.all - a.all);
  if (totals.length) {
    console.log(`  by extension (not single-source / all): ${totals.map(([ext, n]) => `${ext} ${n.competitive}/${n.all}`).join(', ')}`);
  }
  console.log('');
};

const printChannels = async (window) => {
  const rows = await verification.tendersByChannelStatus(window);
  console.log('— tenders by submission channel × status —');
  for (const [channel, cells] of groupsOf(rows, 'submission_channel')) {
    console.log(`  ${channel.padEnd(9)} ${pad(sum(cells, 'n'), 5)}: ${cells.map((row) => `${row.status} ${row.n}`).join(', ')}`);
  }
  console.log('');
};

const printEauctionCoverage = async (window) => {
  const coverage = await verification.eauctionNoticeCoverage(window);
  console.log('— gnumner e-auction notices against e-auction tenders held —');
  console.log(
    `  ${coverage.notices} notices: ${coverage.held} held, ${coverage.missing.length} not held, ` +
      `${coverage.uncoded} with no code (cannot be checked)`
  );
  if (coverage.missing.length) console.log(`  not held: ${coverage.missing.join(', ')}`);
  console.log('');
};

/**
 * Every e-auction procedure in every stored PPCM answer in the window, the
 * newest answer's reading of each, with the raw rows behind it — the rejected
 * flag is in the rows and not in the observation, which does not read it.
 */
const storedEauctionProcedures = async (window) => {
  const { columns } = getSourceConfig('ppcm').organizedProcedures;
  const storage = await getStorage();
  const stored = [
    ...(await sourcePayloads.allByPrefix('ppcm', 'results:')),
    ...(await sourcePayloads.allByPrefix('ppcm', 'sweep:')),
  ]
    .filter((payload) => (!window.from || payload.fetched_at >= window.from) && (!window.to || payload.fetched_at < window.to))
    .sort((a, b) => a.fetched_at - b.fetched_at);

  const procedures = new Map();
  for (const payload of stored) {
    const parsed = parseStored(Buffer.from(await storage.get(payload.storage_key)).toString('utf8'), { columns });
    const observations = parsed.code ? observeProcedures(parsed) : observeDay(parsed).observations;
    for (const observation of observations) {
      if (observation.submissionChannel !== 'eauction') continue;
      const rows = parsed.rows.filter(
        (row) =>
          procedureId(row.tender_reference, Number.isFinite(row.announcement_date) ? new Date(row.announcement_date) : null) ===
          observation.externalId
      );
      procedures.set(observation.externalId, { observation, rows });
    }
  }
  return { payloads: stored.length, procedures: [...procedures.values()] };
};

/** One PPCM procedure against the ledger and awards of the e-auction tender it resolved to. */
const compareProcedure = ({ observation, rows }, ledger, awards, offers, tally) => {
  const bidsAt = (lotNumber, net) =>
    ledger.filter((bid) => Number(bid.lot_number) === Number(lotNumber) && cents(bid.final_offer_net) === cents(net));

  // By bidder: the PPCM bidder's own bid on the lot, found through the ՀՎՀՀ
  // its party holds. A bidder whose party holds none can only be placed by
  // lot and net, which is the join itself, so it is counted apart.
  for (const bidder of observation.bidders) {
    const own = bidder.taxId
      ? offers.filter((offer) => Number(offer.lot_number) === bidder.lotNumber && offer.tax_id === bidder.taxId)
      : [];
    if (!own.length) tally.net[bidsAt(bidder.lotNumber, bidder.net).length ? 'unplacedSameNet' : 'unplacedNoNet'] += 1;
    else tally.net[own.some((offer) => cents(offer.final_offer_net) === cents(bidder.net)) ? 'equal' : 'differ'] += 1;
  }

  // Contract against the gross award: exact, off by rounding (2 AMD, or VAT
  // rounded per item: within 0.1%), or a different amount — a smaller
  // contract is ticket 10's framework or partial-funds case.
  for (const lot of observation.ledger) {
    if (!lot.award) continue;
    const ours = awards.find((award) => Number(award.lot_number) === lot.lotNumber);
    if (!ours || ours.amount === null) {
      tally.contract.noAward += 1;
      continue;
    }
    const [theirs, held] = [cents(lot.award.amount), cents(ours.amount)];
    const gap = Math.abs(theirs - held);
    if (gap === 0) tally.contract.equal += 1;
    else if (gap <= 200 || gap <= held * 0.001) tally.contract.rounding += 1;
    else tally.contract[theirs < held ? 'below' : 'above'] += 1;
  }

  // Once per distinct (lot, bidder, offer): the report repeats a bidder's row
  // for every contract it joins to the lot.
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.lot_number}|${row.participant_taxpayer ?? row.participant_name}|${row.participant_total_price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.bid_rejected === null || row.bid_rejected === undefined) {
      tally.rejection.unstated += 1;
      continue;
    }
    const bids = bidsAt(row.lot_number, row.participant_total_price);
    if (bids.length !== 1) tally.rejection.unjoined += 1;
    else tally.rejection[Boolean(row.bid_rejected) === (bids[0].status === 'rejected') ? 'agree' : 'disagree'] += 1;
  }

  const match = matchTaxIds(observation.bidders, offers);
  tally.taxIds.matched += match.matchedRows;
  tally.taxIds.already += match.already;
  tally.taxIds.stillBlank += match.toAttach.length;
  for (const [why, n] of Object.entries(match.unmatched)) count(tally.taxIds.unmatched, why, n);
};

const printPpcmComparison = async (window) => {
  const { payloads, procedures } = await storedEauctionProcedures(window);
  const tally = {
    decisions: {},
    tenders: new Set(),
    net: { equal: 0, differ: 0, unplacedSameNet: 0, unplacedNoNet: 0 },
    contract: { equal: 0, rounding: 0, below: 0, above: 0, noAward: 0 },
    rejection: { agree: 0, disagree: 0, unstated: 0, unjoined: 0 },
    taxIds: { matched: 0, already: 0, stillBlank: 0, unmatched: {} },
  };

  for (const procedure of procedures) {
    const { observation } = procedure;
    const decision = resolve(observation, await tenders.findCandidates(lookupsFor(observation)));
    const outcome = decision.action === 'link' ? 'link' : `${decision.action} ${decision.reason ?? ''}`.trim();
    count(tally.decisions, outcome);
    if (decision.action !== 'link') continue;

    tally.tenders.add(decision.tenderId);
    const [ledger, awards, offers] = await Promise.all([
      publicBids.ledgerForTender(decision.tenderId),
      publicBids.awardsForTender(decision.tenderId),
      publicBids.netOffersForTender(decision.tenderId, 'eauction'),
    ]);
    compareProcedure(procedure, ledger, awards, offers, tally);
  }

  const parties = await verification.eauctionBidderTaxIds();
  const { net, contract, rejection, taxIds } = tally;
  console.log('— PPCM against the e-auction ledger —');
  console.log(
    `  ${payloads} stored answers, ${procedures.length} e-auction procedures: ` +
      Object.entries(tally.decisions).map(([outcome, n]) => `${n} ${outcome}`).join(', ')
  );
  console.log(`  ${tally.tenders.size} e-auction tenders in both`);
  console.log(
    `  net price, bidder's own bid:      ${net.equal} of ${net.equal + net.differ} equal` +
      ` (${net.unplacedSameNet + net.unplacedNoNet} bidders not placed by ՀՎՀՀ: ${net.unplacedSameNet} with a bid at that lot and net, ` +
      `${net.unplacedNoNet} without)`
  );
  const priced = contract.equal + contract.rounding + contract.below + contract.above;
  console.log(
    `  contract price = gross award:     ${contract.equal} of ${priced}` +
      ` (${contract.rounding} off by rounding — 2 AMD or 0.1% —, ${contract.below} below it, ${contract.above} above it;` +
      ` ${contract.noAward} lots with no award of ours)`
  );
  console.log(
    `  rejection flag:                   ${rejection.agree} agree, ${rejection.disagree} disagree` +
      ` (${rejection.unstated} rows PPCM leaves blank, ${rejection.unjoined} not joined to one bid)`
  );
  const missed = Object.entries(taxIds.unmatched).filter(([, n]) => n > 0);
  console.log(
    `  ՀՎՀՀ join: ${taxIds.matched} bidder rows matched (${taxIds.already} already held, ${taxIds.stillBlank} parties still blank)` +
      (missed.length ? `; not matched: ${missed.map(([why, n]) => `${n} ${why}`).join(', ')}` : '')
  );
  console.log(
    `  e-auction bidders holding a ՀՎՀՀ: ${parties.withTaxId} of ${parties.bidders}` +
      ` (all time — nothing records when one was gained — every one from PPCM); ` +
      `${parties.sharedTaxIds} of them shared with another party`
  );
  console.log('');
};

const run = async () => {
  const window = { from: dateArg('from'), to: dateArg('to') };
  const label = (at) => (at ? at.toISOString() : '…');
  console.log(`window [${label(window.from)}, ${label(window.to)}) over first seen\n`);

  await printSources(window);
  await printFormats(window);
  await printChannels(window);
  await printEauctionCoverage(window);
  await printPpcmComparison(window);
};

run()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`[sources:verify] ${error.stack ?? error.message}`);
    await closeDb();
    process.exit(1);
  });

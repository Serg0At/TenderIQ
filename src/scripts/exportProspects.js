import { closeDb } from '../libs/knex.js';
import { listProspectCandidates } from '../repositories/prospects.repo.js';
import { scoreCandidate } from '../services/prospectScoring.service.js';

/**
 * Generates the ranked prospect export (CSV + JSON) described in
 * docs/PROSPECT_FEASIBILITY.md.
 *
 * Deliberately a script, not an API endpoint — this is a founder-led-sales
 * research tool, not a customer-facing feature (yet), so it has no business
 * behind `features/`.
 *
 * Usage:
 *   AMD_TO_USD=405 node src/scripts/exportProspects.js [--since-months=12] [--min-bids=3]
 *
 * AMD_TO_USD is optional but recommended: without it, value-density scoring
 * is skipped (its weight is redistributed across the other components —
 * see prospectScoring.service.js) rather than silently treated as zero.
 * Look up the current rate rather than reusing an old one; AMD/USD moves.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  })
);

const sinceMonths = args['since-months'] ? Number(args['since-months']) : 12;
const minBids = args['min-bids'] ? Number(args['min-bids']) : 1;
const amdToUsd = process.env.AMD_TO_USD ? Number(process.env.AMD_TO_USD) : undefined;

/**
 * Quoting AND formula-injection defence.
 *
 * supplier_name is scraped HTML that this export hands straight to Excel — its
 * only intended consumer. A supplier whose name begins =, +, -, @, tab or CR is
 * interpreted as a formula and executes on open. Prefixing an apostrophe forces
 * Excel to treat the cell as literal text while leaving the value readable.
 */
const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const toCsv = (rows) => {
  const headers = [
    'supplier_name', 'tax_id', 'bid_count', 'tender_count', 'total_final_value_amd',
    'median_final_value_amd', 'top_categories', 'inferred_vertical', 'priority_tier',
    'win_count', 'loss_count', 'last_tender_published_at', 'icp_score', 'suggested_tier', 'insufficient_data', 'reason',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return lines.join('\n');
};

const run = async () => {
  const candidates = await listProspectCandidates({ sinceMonths, minBids });

  if (candidates.length === 0) {
    const message =
      'insufficient_data: 0 rows in public_tender_bids. The table ships in ' +
      'migrations/create_table.js and is filled by the bids-table parser, but only for ' +
      'tenders that have reached status `awarded` — an ingest that has so far seen only ' +
      'active tenders yields nothing here. This is not a query bug.';
    console.log(message);
    await closeDb();
    process.exit(0);
  }

  const scored = candidates.map((c) => scoreCandidate(c, { amdToUsd }));

  const rows = scored.map((s) => ({
    supplier_name: s.supplierName,
    tax_id: s.taxId,
    bid_count: s.bidCount ?? '',
    tender_count: s.tenderCount ?? '',
    total_final_value_amd: s.insufficientData ? '' : undefined, // filled below from raw candidate if needed
    median_final_value_amd: '',
    top_categories: s.insufficientData ? '' : (s.topCategories ?? []).join('; '),
    inferred_vertical: s.insufficientData ? '' : s.vertical,
    priority_tier: s.insufficientData ? '' : s.priorityTier,
    win_count: s.winCount ?? '',
    loss_count: s.lossCount ?? '',
    last_tender_published_at: s.lastActivityAt ?? '',
    icp_score: s.icpScore ?? '',
    suggested_tier: s.suggestedTier ?? '',
    insufficient_data: s.insufficientData,
    reason: s.reason ?? '',
  }));

  // Backfill value columns from the raw candidate row (score object omits
  // them to stay focused on the scoring inputs, not a full field passthrough).
  candidates.forEach((c, i) => {
    rows[i].total_final_value_amd = c.total_final_value ?? '';
    rows[i].median_final_value_amd = c.median_final_value ?? '';
  });

  const sorted = rows
    .filter((r) => !r.insufficient_data)
    .sort((a, b) => Number(b.icp_score) - Number(a.icp_score))
    .concat(rows.filter((r) => r.insufficient_data));

  const fs = await import('fs');
  const path = await import('path');

  // Written under .storage/, which is already gitignored. These files contain
  // real supplier names and tax IDs; at the repo root a routine `git add .`
  // would publish them to a public remote.
  const outDir = path.join('.storage', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, 'prospects_export.csv');
  const jsonPath = path.join(outDir, 'prospects_export.json');

  fs.writeFileSync(csvPath, toCsv(sorted));
  fs.writeFileSync(jsonPath, JSON.stringify(sorted, null, 2));

  console.log(`Wrote ${sorted.length} rows (${sorted.filter((r) => !r.insufficient_data).length} scored, ` +
    `${sorted.filter((r) => r.insufficient_data).length} insufficient_data) to ${csvPath} / ${jsonPath}`);
  if (!amdToUsd) {
    console.log('NOTE: AMD_TO_USD was not set — value-density scoring was skipped for every row.');
  }

  await closeDb();
};

run().catch(async (error) => {
  console.error('[exportProspects] failed:', error);
  await closeDb();
  process.exit(1);
});

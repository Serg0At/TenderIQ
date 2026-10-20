import { significantPrefix } from './cpv.js';

/**
 * Field: the industry an organization works in, chosen from this list.
 *
 * Each field names the CPV prefixes it covers — a 2-digit division, or a
 * 3-digit group where a division would otherwise belong to two fields (30 splits
 * into office machinery and computer equipment; 39 is furniture except for 398,
 * cleaning products). This constant is the only definition of "what counts as
 * medical": the Discovery `filter[field]` and the relevance field signal both
 * read it, and two answers to that question would drift apart the first time
 * one of them was fixed.
 *
 * The ids are a wire contract and are stored in `organizations.type`, so they
 * never change; the prefixes may, and a change takes effect everywhere at once.
 * There is deliberately no "other": fields are optional, so "none of these" is
 * choosing none — an `other` would count as having a field while matching
 * nothing, and the relevance list would claim a basis it does not have.
 *
 * Checked against the corpus on 2026-10-17: every CPV division present on a lot
 * falls under exactly one field. The draft list in the spec was extended for the
 * divisions it missed — 14 (sand, stone), 35 (security and fire equipment), 37
 * (sport, music, toys), 41 (water), 51 (installation), 63 (transport support),
 * 64 (postal and telecom services) and 92 (recreation) — and education, which
 * had no lots at all under 80, now carries the leisure goods schools buy.
 */
export const FIELDS = [
  { id: 'furniture', cpvPrefixes: ['391', '392', '393', '395', '397'] },
  { id: 'it_telecom', cpvPrefixes: ['302', '32', '48', '64', '72'] },
  { id: 'medical', cpvPrefixes: ['33', '85'] },
  { id: 'fuel_energy', cpvPrefixes: ['09'] },
  { id: 'electrical', cpvPrefixes: ['31'] },
  { id: 'construction', cpvPrefixes: ['14', '44', '45'] },
  { id: 'vehicles_transport', cpvPrefixes: ['34', '60', '63'] },
  { id: 'professional_services', cpvPrefixes: ['66', '71', '73', '79'] },
  { id: 'industrial_machinery', cpvPrefixes: ['16', '42', '43', '51'] },
  { id: 'laboratory', cpvPrefixes: ['38'] },
  { id: 'chemicals_cleaning', cpvPrefixes: ['24', '398'] },
  { id: 'office_stationery', cpvPrefixes: ['22', '301'] },
  { id: 'food_catering', cpvPrefixes: ['03', '15', '41', '55'] },
  { id: 'facilities_security', cpvPrefixes: ['35', '90', '98'] },
  { id: 'education_leisure', cpvPrefixes: ['37', '80', '92'] },
  { id: 'textiles_workwear', cpvPrefixes: ['18', '19'] },
];

/** How many fields one organization may claim. Past this, the list matches everything. */
export const MAX_FIELDS = 3;

export const FIELD_IDS = FIELDS.map((field) => field.id);

const PREFIXES_BY_ID = new Map(FIELDS.map((field) => [field.id, field.cpvPrefixes]));

/**
 * Refuse to load an ambiguous list. A prefix inside another field's prefix would
 * make one CPV code belong to two industries, and the filter and the ranking
 * would each quietly pick one. Same posture as `TRANSPORTS` refusing to load
 * when its keys disagree with the channel list.
 */
const allPrefixes = FIELDS.flatMap((field) => field.cpvPrefixes.map((prefix) => ({ id: field.id, prefix })));
for (const a of allPrefixes) {
  for (const b of allPrefixes) {
    if (a !== b && b.prefix.startsWith(a.prefix)) {
      throw new Error(`[fields] CPV prefix ${b.prefix} (${b.id}) sits inside ${a.prefix} (${a.id})`);
    }
  }
}

/**
 * Refuse a prefix that is not a code's significant prefix. The field filter
 * matches its prefixes the way `covers` matches a code (tender.repo.js#
 * coversAnySql), which holds only while each prefix IS one: "3010" would match
 * class 3010 while the code it stands for, 30100000, covers all of group 301.
 */
for (const { id, prefix } of allPrefixes) {
  if (significantPrefix(prefix.padEnd(8, '0')) !== prefix) {
    throw new Error(`[fields] CPV prefix ${prefix} (${id}) is not the significant prefix of a code`);
  }
}

/** Every CPV prefix the given fields cover, de-duplicated. Unknown ids contribute nothing. */
export const cpvPrefixesFor = (fieldIds = []) =>
  [...new Set(fieldIds.flatMap((id) => PREFIXES_BY_ID.get(id) ?? []))];

/** The field a CPV code falls under, or null. */
export const fieldOf = (cpvCode) => {
  if (!cpvCode) return null;
  const code = String(cpvCode);
  return allPrefixes.find(({ prefix }) => code.startsWith(prefix))?.id ?? null;
};

export default { FIELDS, FIELD_IDS, MAX_FIELDS, cpvPrefixesFor, fieldOf };

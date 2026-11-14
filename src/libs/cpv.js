/**
 * The CPV hierarchy: one answer to "is this code in that category, and how
 * closely".
 *
 * CPV codes are 8 digits read left to right: 33141110 sits in group 331, in
 * division 33. Two questions are asked of it:
 *
 *   - the alert matcher and the Discovery CPV and field filters ask a yes/no
 *     question — does a saved search's or a filter's code COVER this tender's
 *     code? A search for 33000000 covers 33141110; a search
 *     for 33141110 does not cover 33000000. Directional, because a supplier who
 *     asked for a whole division wants every child, and one who asked for a
 *     single item does not want its whole division.
 *   - relevance asks how CLOSE two codes are — same code, same 3-digit group,
 *     same 2-digit division — because an exact code is far stronger evidence of
 *     fit than a shared division. Symmetric: a supplier who bid on 33141110 is
 *     as related to 33141200 as the other way round.
 *
 * Both live here so a fix to one is a fix to both. Pure: no database, no clock,
 * no configuration.
 */

/** Strongest first. `none` is not a level; it is the absence of one. */
export const CPV_LEVELS = ['exact', 'group', 'division'];

const RANK = { exact: 3, group: 2, division: 1, none: 0 };

/** Compare two levels: positive when `a` is the stronger. */
export const compareLevels = (a, b) => (RANK[a] ?? 0) - (RANK[b] ?? 0);

/**
 * The part of a code that carries meaning: trailing zeros are padding, so
 * 33100000 means "group 331, anything under it".
 *
 * Never shorter than a division. The division is the first two digits, and a
 * zero there is part of it rather than padding: 30000000 is "division 30"
 * (office machinery), not "anything starting with 3" — which would cover
 * electrical machinery, medical equipment and the rest of 31–39 too.
 *
 * What `covers` reduces to, and so the prefix the SQL filters match with
 * (tender.repo.js#coversAnySql): a code covers exactly the codes that start
 * with this.
 */
export const significantPrefix = (code) => {
  const text = String(code ?? '');
  const stripped = text.replace(/0+$/, '');
  return stripped.length >= 2 ? stripped : text.slice(0, 2);
};

/** Does `wanted` cover `have` — the same code, or `have` sits under it? */
export const covers = (wanted, have) => {
  if (!have || !wanted) return false;
  if (String(have) === String(wanted)) return true;
  const prefix = significantPrefix(wanted);
  return prefix !== '' && String(have).startsWith(prefix);
};

/**
 * A code's level in the classifier, read from its significant digits:
 * 45000000 is a division, 45200000 a group, 45230000 a class, 45231000 a
 * category, anything finer a code. An inferred code may be any level — a
 * vague lot deserves a broad code — and the level tells a reader how broad.
 */
export const cpvLevel = (code) => {
  const digits = significantPrefix(code).length;
  if (digits <= 2) return 'division';
  if (digits === 3) return 'group';
  if (digits === 4) return 'class';
  if (digits === 5) return 'category';
  return 'code';
};

/** How close two codes are: 'exact' | 'group' | 'division' | 'none'. Symmetric. */
export const closeness = (a, b) => {
  if (!a || !b) return 'none';
  const left = String(a);
  const right = String(b);
  if (left === right) return 'exact';
  if (left.length >= 3 && left.slice(0, 3) === right.slice(0, 3)) return 'group';
  if (left.length >= 2 && left.slice(0, 2) === right.slice(0, 2)) return 'division';
  return 'none';
};

/**
 * The words that mark a CPV reason resting only on an inferred code, in an
 * alert's reasons and in a digest line (cpv-inference ticket 05). One string,
 * so the matcher that writes it and the renderers that show it cannot drift.
 */
export const INFERRED_CPV_MARK = '(inferred CPV)';

/**
 * Whether a tender's inferred lot codes count: its purchase kind (the gate's
 * reading, libs/purchaseKinds.js#gateKindOf) is one `CPV_INFERENCE.READ_KINDS`
 * lists. A tender with no kind never passes, and an empty list passes none.
 */
export const readsInferred = (purchaseKind, inferredKinds = []) =>
  Boolean(purchaseKind) && (inferredKinds ?? []).includes(purchaseKind);

/**
 * Every code a tender carries for discovery, primary first, each once: its
 * primary code, every code its source lists for the tender as a whole, its
 * lots' codes — and, behind the gate, its lots' inferred codes (ADR 0006).
 *
 * The one list each discovery reader asks the questions above of: the
 * matcher, and through its SQL twin (tender.repo.js#tenderCodesSql — change
 * both) the CPV and field filters and relevance. A code the source states
 * for the tender without saying which lot it belongs to (armeps.am lists the
 * tender's codes but not which lot is which) is still a fact about the
 * tender, and a reader that looked only at lots, or only at the primary code,
 * would miss a tender a supplier asked for.
 *
 * Inferred codes come in only when `readsInferred(purchaseKind,
 * inferredKinds)`. Pure, so the gate arrives as an argument and its default
 * is shut: a caller that passes none reads stated codes alone, exactly as
 * before ticket 05. No intelligence figure calls this.
 */
export const tenderCodes = (
  { cpvCode = null, cpvCodes = [], lotCodes = [], inferredLotCodes = [], purchaseKind = null } = {},
  { inferredKinds = [] } = {}
) =>
  [...new Set([
    cpvCode,
    ...(cpvCodes ?? []),
    ...(lotCodes ?? []),
    ...(readsInferred(purchaseKind, inferredKinds) ? inferredLotCodes ?? [] : []),
  ].filter(Boolean).map(String))];

/** Both answers for one pair: how close, and whether `wanted` covers `have`. */
export const compareCpv = (have, wanted) => ({ level: closeness(have, wanted), covered: covers(wanted, have) });

/**
 * The closest pair between a tender's codes and a set of wanted codes.
 *
 * Returns `{ level, code, wanted }` for the strongest pair, or `{ level: 'none' }`.
 * Ties keep the first pair found, so the caller's ordering decides which code a
 * reason names.
 */
export const bestCpvMatch = (codes = [], wantedCodes = []) => {
  let best = { level: 'none', code: null, wanted: null };
  for (const code of codes) {
    if (!code) continue;
    for (const wanted of wantedCodes) {
      const level = closeness(code, wanted);
      if (compareLevels(level, best.level) > 0) {
        best = { level, code, wanted };
        if (level === 'exact') return best;
      }
    }
  }
  return best;
};

export default {
  CPV_LEVELS,
  INFERRED_CPV_MARK,
  compareLevels,
  significantPrefix,
  cpvLevel,
  covers,
  closeness,
  readsInferred,
  tenderCodes,
  compareCpv,
  bestCpvMatch,
};

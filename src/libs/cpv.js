/**
 * The CPV hierarchy: one answer to "is this code in that category, and how
 * closely".
 *
 * CPV codes are 8 digits read left to right: 33141110 sits in group 331, in
 * division 33. Two callers ask about it, differently:
 *
 *   - the alert matcher asks a yes/no question — does a saved search's code
 *     COVER this tender's code? A search for 33000000 covers 33141110; a search
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
 * Known sharp edge, kept because the alert matcher's behaviour must not move
 * under a refactor: a division whose second digit is 0 (30, 60, 80, 90…) loses
 * that zero too, so 30000000 reduces to "3" and covers every 3x division.
 */
export const significantPrefix = (code) => String(code ?? '').replace(/0+$/, '');

/** Does `wanted` cover `have` — the same code, or `have` sits under it? */
export const covers = (wanted, have) => {
  if (!have || !wanted) return false;
  if (String(have) === String(wanted)) return true;
  const prefix = significantPrefix(wanted);
  return prefix !== '' && String(have).startsWith(prefix);
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

export default { CPV_LEVELS, compareLevels, significantPrefix, covers, closeness, compareCpv, bestCpvMatch };

/**
 * Inferred CPV codes (ADR 0006): how a code is chosen for a lot whose source
 * states none. Pure — candidates in, a code or none out — so the backtest runs
 * exactly the rule production will.
 *
 * A candidate is what `cpvCandidate.repo.js#candidatesFor` returns:
 *   { code, name, level, uses, lotSimilarity, nameSimilarity }
 * `lotSimilarity` is the similarity of the most similar stated-code lot that
 * carried the code (null when the code came from the classifier's names
 * alone); `uses` is how many tenders put it on a similar lot.
 */

/**
 * How similar the nearest stated-code lot must be for `nearest` to take its
 * code. Below it the answer is none: an uncoded lot sends no wrong alert, and
 * a far neighbour's code would. Chosen from `npm run cpv:backtest`'s floor
 * sweep (cpv-inference ticket 02 records the numbers): at 0.6 ARMEPS services
 * agree on the division 93%, against 90% at 0.5, for 7 points less coverage,
 * and goods do no worse; above it services lose half their answers.
 */
export const NEAREST_FLOOR = 0.6;

/**
 * The no-model method: the code of the single most similar stated-code lot,
 * if that lot is at least `floor` similar; otherwise none (null).
 *
 * Two buyers sometimes code the same name differently, so lots can tie at the
 * top. The tie goes to the code more tenders used on similar lots, then to the
 * lower code, so the answer never depends on row order.
 */
export const nearest = (candidates, { floor = NEAREST_FLOOR } = {}) => {
  let best = null;
  for (const c of candidates ?? []) {
    if (c.lotSimilarity === null || c.lotSimilarity === undefined || c.lotSimilarity < floor) continue;
    if (
      !best ||
      c.lotSimilarity > best.lotSimilarity ||
      (c.lotSimilarity === best.lotSimilarity &&
        (c.uses > best.uses || (c.uses === best.uses && c.code < best.code)))
    ) {
      best = c;
    }
  }
  return best ? best.code : null;
};

export default { NEAREST_FLOOR, nearest };

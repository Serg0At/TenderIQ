import Joi from 'joi';
import { cpvLevel } from '../libs/cpv.js';

/**
 * Inferred CPV codes (ADR 0006): how a code is chosen for a lot whose source
 * states none. Pure — candidates (and, for `model`, the model's answer) in, a
 * code or none out — so the backtest runs exactly the rule production will. The
 * model call itself is `cpvModel.service.js`.
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

/** A code's division and group: `03111200` → `03000000`, `03100000` (itself left out). */
const ancestorsOf = (code) => [`${code.slice(0, 2)}000000`, `${code.slice(0, 3)}00000`].filter((a) => a !== code);

/**
 * What the `model` method may answer with: every candidate, then each
 * candidate's division and group from the classifier's outline that is not a
 * candidate already, marked `broader`. A vague lot («շինանյութեր») whose
 * candidates scatter across one group can then take the group's code rather
 * than a falsely precise one (spec, story 8) — and the answer is still drawn
 * from the closed set, never written. A withdrawn division or group is not in
 * the outline and is not offered.
 *
 * `outline` is `cpvClassifier.repo.js#outline`'s `[{ code, name }]`.
 */
export const offeredCodes = (candidates, outline = []) => {
  const names = new Map(outline.map((o) => [o.code, o.name]));
  const offered = (candidates ?? []).map((c) => ({ ...c, broader: false }));
  const seen = new Set(offered.map((c) => c.code));
  const broader = [];
  for (const c of offered) {
    for (const code of ancestorsOf(c.code)) {
      if (seen.has(code) || !names.has(code)) continue;
      seen.add(code);
      broader.push({ code, name: names.get(code), level: cpvLevel(code), uses: 0, lotSimilarity: null, nameSimilarity: null, broader: true });
    }
  }
  return [...offered, ...broader.sort((a, b) => (a.code < b.code ? -1 : 1))];
};

/** The answer the model must give, re-checked here after the API constrained it. */
const answerSchema = Joi.object({
  reason: Joi.string().trim().max(1000).allow('').required(),
  code: Joi.string().trim().required(),
  confidence: Joi.number().min(0).max(1).required(),
}).options({ stripUnknown: true });

/**
 * Judge the `model` method's answer in code — the inferred code's equivalent
 * of the checklist's `verifyEvidence`. A prompt says "answer from the list";
 * this makes it so. Returns `{ code, reason, confidence, explanation }`, with
 * `code` null and `reason` saying why whenever no code is to be written:
 *
 *   refused | truncated | empty | unparseable   the model gave no usable answer
 *                                               (`stop_reason` read before content)
 *   invalid_output                              the answer is not the schema's shape
 *   none                                        the model said none fits
 *   not_offered                                 a code outside the offered set
 *   not_in_classifier                           a code the classifier lacks or withdrew
 *   low_confidence                              below `minConfidence`
 *
 * Any classifier level is accepted: a division or a group is a legitimate
 * answer for a vague lot. `result` is the AI adapter's discriminated result;
 * `offered` the codes the model was given; `classifier` the set of those the
 * classifier holds live (`cpvClassifier.repo.js#liveCodes`).
 */
export const judgeModelAnswer = (result, { offered, classifier, minConfidence }) => {
  if (result?.status !== 'ok') return { code: null, reason: result?.status ?? 'empty', confidence: null, explanation: null };
  const { value, error } = answerSchema.validate(result.data);
  if (error) return { code: null, reason: 'invalid_output', confidence: null, explanation: null };

  const code = value.code;
  const base = { confidence: value.confidence, explanation: value.reason || null };
  if (code.toLowerCase() === 'none') return { code: null, reason: 'none', ...base };
  if (!new Set(offered).has(code)) return { code: null, reason: 'not_offered', ...base, answered: code };
  if (!classifier.has(code)) return { code: null, reason: 'not_in_classifier', ...base, answered: code };
  if (value.confidence < minConfidence) return { code: null, reason: 'low_confidence', ...base, answered: code };
  return { code, reason: null, ...base };
};

export default { NEAREST_FLOOR, nearest, offeredCodes, judgeModelAnswer };

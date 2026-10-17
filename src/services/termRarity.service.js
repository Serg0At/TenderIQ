/**
 * Rarity-weighted word overlap: the relevance fallback for a tender that
 * carries no CPV code anywhere.
 *
 * Plain overlap would be useless here. Tender titles and lot names are full of
 * procurement boilerplate — "կարիքների համար" (for the needs of), "ձեռքբերում"
 * (acquisition), "տես կից ֆայլը" (see attached file) — present in a large share
 * of the corpus. So every word is weighted by how rare it is across the
 * documents at hand: a word in more than COMMON_SHARE of them counts for
 * nothing, and `ռենտգեն` (X-ray) counts for a lot.
 *
 * Armenian inflects by suffix — ռենտգեն, ռենտգենի, ռենտգենյան — so a word is
 * cut to a STEM_LENGTH prefix before comparing. Crude, deliberately: Postgres
 * ships no Armenian stemmer, and a prefix is predictable and explainable.
 *
 * Pure: documents in, numbers out. No database, no clock. Its own module so it
 * can be read and probed on its own, apart from the scorer that calls it.
 */

/** Words shorter than this carry little: particles, abbreviations, numbering. */
export const MIN_WORD_LENGTH = 4;

/** Characters kept from each word, absorbing case endings. */
export const STEM_LENGTH = 6;

/** A stem in more than this share of the documents is boilerplate and weighs 0. */
export const COMMON_SHARE = 0.2;

/**
 * A stem in at least this share of the profile's documents is fully
 * characteristic of it; rarer ones count proportionally less. Presence alone is
 * not evidence: three hundred tenders of a busy supplier contain nearly every
 * word, and a title would "match" on a buyer's name in one of them.
 */
export const PROFILE_SHARE = 0.1;

/**
 * Procedure vocabulary, by stem: words that describe HOW something is bought —
 * procedure, announcement, invitation, auction, purpose, code — and never WHAT.
 * Rarity catches most boilerplate on its own, but these sit in long-form titles
 * often enough to matter and not often enough to cross COMMON_SHARE. Kept short
 * and explicit; `էլեկտր` (electronic auction) is deliberately absent, since the
 * same stem is electrical goods.
 */
const PROCEDURE_STEMS = new Set(['ընթացա', 'հայտար', 'հրավեր', 'նպատակ', 'գնման', 'աճուրդ', 'ծածկագ']);

/**
 * The stems of a text, each mapped to the first surface word it came from — the
 * word a reason shows, since a stem like `ռենտգե` reads as a typo.
 */
export const termsOf = (text) => {
  const terms = new Map();
  for (const word of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const letters = word.replace(/\p{N}/gu, '');
    if (letters.length < MIN_WORD_LENGTH) continue;
    const stem = [...word].slice(0, STEM_LENGTH).join('');
    if (PROCEDURE_STEMS.has(stem)) continue;
    if (!terms.has(stem)) terms.set(stem, word);
  }
  return terms;
};

/**
 * Inverse document frequency over a set of documents (each a `termsOf` map),
 * computed once. Returns `stem → weight`, with boilerplate at 0 and a stem the
 * corpus never saw weighted as if seen once.
 */
export const buildRarity = (documents) => {
  const df = new Map();
  for (const terms of documents) {
    for (const stem of terms.keys()) df.set(stem, (df.get(stem) ?? 0) + 1);
  }
  const n = documents.length;
  return (stem) => {
    const count = df.get(stem) ?? 1;
    if (n > 0 && count / n > COMMON_SHARE) return 0;
    return Math.log((n + 1) / (count + 1));
  };
};

/**
 * A profile: the documents that characterise an organization (`termsOf` maps),
 * reduced to how many of them contain each stem.
 */
export const buildProfile = (documents) => {
  const df = new Map();
  for (const terms of documents) {
    for (const stem of terms.keys()) df.set(stem, (df.get(stem) ?? 0) + 1);
  }
  return { df, size: documents.length };
};

const characteristic = (profile, stem) => {
  const count = profile.df.get(stem) ?? 0;
  return count ? Math.min(1, count / profile.size / PROFILE_SHARE) : 0;
};

/**
 * How much of a document's distinctive vocabulary is characteristic of the
 * profile: each stem's rarity, times how characteristic it is of the profile,
 * over the rarity of all the document's stems — 0 to 1. Boilerplate weighs
 * nothing, so a title that is all boilerplate scores 0 rather than matching
 * everything.
 *
 * Returns `{ share, terms }`, `terms` being the contributing surface words,
 * strongest first.
 */
export const overlap = (docTerms, profile, rarity) => {
  let total = 0;
  let shared = 0;
  const hits = [];
  for (const [stem, word] of docTerms) {
    const weight = rarity(stem);
    total += weight;
    const contribution = weight * characteristic(profile, stem);
    if (contribution > 0) {
      shared += contribution;
      hits.push({ word, contribution });
    }
  }
  return {
    share: total > 0 ? shared / total : 0,
    terms: hits.sort((a, b) => b.contribution - a.contribution).map((h) => h.word),
  };
};

export default { termsOf, buildRarity, buildProfile, overlap, MIN_WORD_LENGTH, STEM_LENGTH, COMMON_SHARE, PROFILE_SHARE };

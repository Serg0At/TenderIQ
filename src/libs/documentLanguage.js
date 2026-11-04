/**
 * The language a tender file is in, as its NAME says — or null.
 *
 * Read from the filename only, never from content and never from a default:
 * a file tagged HY that turns out to be Russian sends a supplier to the wrong
 * copy of a document they are about to bid against, while an untagged file
 * costs them one click. So a language is returned only when the name carries
 * a marker for exactly one; none, or markers for two, is null.
 *
 * Markers are whole tokens of the name (split on anything that is not a
 * letter or digit), so `_RU`, `-ru.` and `Obyavlenie_RU` count, while `ru`
 * inside `truck` does not. `am` is left out on purpose: it is Armenia's
 * country code but not a language code, and it is also an ordinary English
 * word and the start of time stamps (`10am`). Source-specific knowledge —
 * eauction's `hraver.docx` is the Armenian invitation — belongs to that
 * source's adapter, which can override this.
 */

const MARKERS = {
  hy: ['hy', 'hye', 'arm', 'hayeren', 'հայերեն', 'հայ'],
  ru: ['ru', 'rus', 'ruseren', 'russian', 'русский', 'рус', 'ռուսերեն'],
  en: ['en', 'eng', 'english', 'angleren', 'անգլերեն'],
};

const LANGUAGE_OF = new Map(
  Object.entries(MARKERS).flatMap(([language, tokens]) => tokens.map((token) => [token, language]))
);

export const LANGUAGES = Object.keys(MARKERS);

/** @param {string} filename a basename, with or without its extension */
export const languageOfFilename = (filename) => {
  const stem = String(filename ?? '').replace(/\.[^.]*$/, '');
  const found = new Set(
    stem
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => LANGUAGE_OF.get(token))
      .filter(Boolean)
  );
  return found.size === 1 ? [...found][0] : null;
};

export default { LANGUAGES, languageOfFilename };

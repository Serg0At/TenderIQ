/**
 * Armenian typed in an ArmSCII-8 *font* (Arial Armenian and its kin) and
 * saved by a program that took the bytes for Latin-1: «գյուղատնտեսական»
 * arrives as "·ÛáõÕ³ïÝï»ë³Ï³Ý". The Ministry of Finance's CPV classifier is
 * written this way.
 *
 * Decoded **per character**, never per cell: one cell can hold font text,
 * genuine Unicode Armenian typed later («ցանց» + "ֆդս" in 37451411), Cyrillic
 * (ПВ-3) and real Latin (j01cr02, COVID19). Only U+00A0–U+00FF are font
 * bytes. ASCII passes through, but for the grave accent. Anything above
 * U+00FF is already Unicode and passes through too.
 *
 * The table is standard ArmSCII-8 with the font's differences, each read off
 * the classifier (2026-11-11) rather than assumed:
 * - 0xA8 is «և» (1,587 times; 03100000 «գյուղատնտեսական և այգեգործական …»). Standard
 *   ArmSCII-8 puts «և» at 0xA2 and an em dash here.
 * - 0xAD is a soft hyphen, dropped: all four sit at syllable breaks inside a
 *   word («իմունա·գլո·բուլին»), where a word processor puts hyphenation points.
 * - "`" is the Armenian comma «՝» (349 times: «ձուկ՝ սառեցրած»), the key the
 *   font's keyboard layout gives it.
 *
 * A byte the font's use here never showed (0x80–0x9F, 0xA1, 0xA2, 0xFF) is
 * left as it is, so `hasUndecoded` can report it instead of a guess hiding it.
 */

const PUNCTUATION = new Map([
  [0xa0, ' '],
  [0xa3, '։'],
  [0xa4, ')'],
  [0xa5, '('],
  [0xa6, '»'],
  [0xa7, '«'],
  [0xa8, 'և'],
  [0xa9, '.'],
  [0xaa, '՝'],
  [0xab, ','],
  [0xac, '-'],
  [0xad, ''],
  [0xae, '…'],
  [0xaf, '՜'],
  [0xb0, '՛'],
  [0xb1, '՞'],
  [0xfe, '՚'],
  [0x60, '՝'],
]);

/** 0xB2–0xFD: Ա ա Բ բ … Ֆ ֆ, capital on the even byte. */
const LETTERS_FROM = 0xb2;
const LETTERS_TO = 0xfd;
const CAPITAL_A = 0x0531;
const SMALL_A = 0x0561;

const decodeChar = (ch) => {
  const code = ch.charCodeAt(0);
  if (PUNCTUATION.has(code)) return PUNCTUATION.get(code);
  if (code >= LETTERS_FROM && code <= LETTERS_TO) {
    const offset = code - LETTERS_FROM;
    return String.fromCharCode((offset % 2 ? SMALL_A : CAPITAL_A) + Math.floor(offset / 2));
  }
  return ch;
};

/**
 * Font-encoded Armenian, as Unicode. Not idempotent: its own «» are U+00AB and
 * U+00BB, which as font bytes are a comma and «Ի». Decode a cell once.
 */
export const fromArmsciiFont = (text) => String(text).replace(/[` -ÿ]/g, decodeChar);

/**
 * Whether a decoded string still holds a Latin-1 character the table does not
 * map — any but the «» it writes itself.
 */
export const hasUndecoded = (text) => /[\u0080-ª¬-º¼-ÿ]/.test(text);

export default { fromArmsciiFont, hasUndecoded };

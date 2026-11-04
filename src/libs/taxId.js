/**
 * Pure: a buyer's ՀՎՀՀ as an invitation states it (ticket 19).
 *
 * The Ministry of Finance invitation template — e-auction's, armeps.am's and a
 * paper quotation's alike — carries a bank-guarantee form whose field 11 is the
 * guarantee's beneficiary, which is the buyer:
 *
 *   10. Շահառուի ՀԾՀ (չի լրացվում)  11. Շահառուի ՀՎՀՀ` 08602899  12. Շահառուի …
 *
 * That field, not any ՀՎՀՀ in the text, is what is read. A document names
 * other tax numbers — a bank's, a parent ministry's (two national parks both
 * print 02507198 beside their own) — and the first or only one is not
 * necessarily the buyer's. Checked against 300 e-auction invitations: the field
 * held exactly one value in 294, and every one equalled the ՀՎՀՀ e-auction's
 * own rule had already given that buyer.
 *
 * Exactly eight digits: a ninth (a typo'd «002698732» is seen) makes the value
 * unreadable rather than its first eight. Some buyers type the label twice
 * («Շահառուի ՀՎՀՀ` ՀՎՀՀ` 02534328»).
 */
const BENEFICIARY_RE = /Շահառուի\s+ՀՎՀՀ(?:[`'՝\s:\-]*ՀՎՀՀ)?[`'՝\s:\-]*(\d{8})(?!\d)/gu;

/** Every distinct value the beneficiary field holds in one text. */
export const beneficiaryTaxIds = (text) =>
  [...new Set([...String(text ?? '').matchAll(BENEFICIARY_RE)].map((match) => match[1]))];

/**
 * The one value every reading of a document set agrees on, or null. A set's
 * translations repeat the form, so two values is no value: a missing ՀՎՀՀ is
 * recoverable, while a wrong one merges two buyers.
 */
export const agreedTaxId = (values) => {
  const found = new Set(values);
  return found.size === 1 ? [...found][0] : null;
};

export default { beneficiaryTaxIds, agreedTaxId };

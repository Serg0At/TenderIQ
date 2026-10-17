/**
 * Purchase kind: whether a tender buys goods, works or services.
 *
 * The source labels every tender with one of three Armenian words, and the
 * detail parser stores that label verbatim in `tenders.goods_works_services`.
 * The wire speaks stable ASCII codes instead, the same way `procedureType` does,
 * so a client never has to match on Armenian text and the label can be
 * re-spelled by the source without breaking a saved filter.
 *
 * A property of the tender, never of the organization — see `Field` for that.
 */
export const PURCHASE_KINDS = {
  goods: 'Ապրանք',
  works: 'Աշխատանք',
  services: 'Ծառայություն',
};

export const PURCHASE_KIND_CODES = Object.keys(PURCHASE_KINDS);

const CODE_BY_LABEL = new Map(Object.entries(PURCHASE_KINDS).map(([code, label]) => [label, code]));

/** The wire code for a stored label; null for a blank or a label the source never used to emit. */
export const purchaseKindOf = (label) => CODE_BY_LABEL.get(label) ?? null;

/** Stored labels for a list of wire codes — what the repository filters on. */
export const purchaseKindLabels = (codes) => codes.map((code) => PURCHASE_KINDS[code]).filter(Boolean);

export default { PURCHASE_KINDS, PURCHASE_KIND_CODES, purchaseKindOf, purchaseKindLabels };

/**
 * The single shape every response takes: `{ data, meta }` on success,
 * `{ error }` on failure.
 *
 * Centralised so no controller can invent its own envelope. Clients that have
 * learned one shape keep working as endpoints are added.
 */
export const ok = (res, data, meta) =>
  res.status(200).json(meta === undefined ? { data } : { data, meta });

export const created = (res, data) => res.status(201).json({ data });

export const noContent = (res) => res.status(204).end();

/**
 * Cursor pagination by default — offsets drift when rows are inserted mid-scan,
 * which for a feed of newly published tenders is the normal case, not an edge
 * case. Ordering must always carry an id tiebreaker or cursors repeat rows.
 */
export const paginated = (res, rows, { cursor = null, hasMore = false } = {}) =>
  res.status(200).json({ data: rows, meta: { cursor, hasMore } });

export default { ok, created, noContent, paginated };

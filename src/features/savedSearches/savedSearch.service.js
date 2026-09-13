import savedSearches from '../../repositories/savedSearch.repo.js';
import { ApiError } from '../../utils/errors.js';

const present = (row) => ({
  id: row.id,
  name: row.name,
  cpvCodes: row.cpv_codes ?? [],
  keywords: row.keywords ?? [],
  regions: row.regions ?? [],
  minValue: row.min_value === null ? null : Number(row.min_value),
  maxValue: row.max_value === null ? null : Number(row.max_value),
  channels: row.channels ?? [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export default class SavedSearchService {
  static async list(organizationId) {
    return (await savedSearches.listForOrg(organizationId)).map(present);
  }

  static async create(organizationId, profile) {
    return present(await savedSearches.create(organizationId, profile));
  }

  /**
   * A row belonging to another tenant answers NOT_FOUND, not FORBIDDEN: the
   * repository already filters by organization, so a miss is indistinguishable
   * from a wrong id — and saying "forbidden" would confirm the id is real.
   */
  static async update(organizationId, id, profile) {
    const row = await savedSearches.update(id, organizationId, profile);
    if (!row) throw ApiError.notFound('Saved search');
    return present(row);
  }

  static async remove(organizationId, id) {
    const deleted = await savedSearches.remove(id, organizationId);
    if (!deleted) throw ApiError.notFound('Saved search');
    return { deleted: true };
  }
}

import db from '../libs/knex.js';

/**
 * The evidence relevance ranks on, for one organization.
 *
 * Every read is scoped on `organization_id` here, not by the caller: saved
 * searches and fields are this tenant's own claims, and nothing read for one
 * organization's ranking may describe another's.
 */
export default class RelevanceRepository {
  /**
   * The organization's signal bundle, loaded once per request.
   *
   * Shaped for `rankTenders`: camelCase, no Knex rows past this point.
   */
  static async signalsFor(organizationId, trx = db) {
    const [organization, searches] = await Promise.all([
      trx('organizations').where({ id: organizationId }).first('type'),
      trx('saved_searches')
        .where({ organization_id: organizationId })
        .orderBy([{ column: 'created_at' }, { column: 'id' }])
        .select('id', 'name', 'cpv_codes', 'keywords', 'min_value', 'max_value'),
    ]);

    return {
      fields: organization?.type ?? [],
      savedSearches: searches.map((s) => ({
        id: s.id,
        name: s.name,
        cpvCodes: s.cpv_codes ?? [],
        keywords: s.keywords ?? [],
        minValue: s.min_value,
        maxValue: s.max_value,
      })),
    };
  }
}

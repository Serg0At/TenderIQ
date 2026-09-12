import notifications from '../../repositories/notification.repo.js';
import { ApiError } from '../../utils/errors.js';

const present = (row) => ({
  id: row.id,
  type: row.type,
  tenderId: row.tender_id,
  payload: row.payload,
  readAt: row.read_at,
  createdAt: row.created_at,
});

/**
 * The alert feed.
 *
 * There is no preference layer here any more. Where an organization can be
 * reached is decided by the rows in `channel_subscriptions`, managed under
 * `/integrations`, so this feature reads notifications and nothing else — one
 * question, one place to answer it.
 */
export default class NotificationService {
  static async list(organizationId, { limit = 50 } = {}) {
    return (await notifications.listForOrg(organizationId, { limit })).map(present);
  }

  /**
   * Scoped by organization in the repository, so a notification belonging to
   * another tenant simply is not found — the caller cannot probe for it.
   */
  static async markRead(organizationId, id) {
    const updated = await notifications.markRead(id, organizationId);
    if (!updated) throw ApiError.notFound('Notification');
    return { id, readAt: new Date().toISOString() };
  }
}

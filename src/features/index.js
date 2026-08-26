import { Router } from 'express';
import authRoutes from './auth/auth.routes.js';
import tenderRoutes from './tenders/tender.routes.js';
import savedSearchRoutes from './savedSearches/savedSearch.routes.js';
import notificationRoutes from './notifications/notification.routes.js';
import intelligenceRoutes from './intelligence/intelligence.routes.js';
import integrationRoutes from './integrations/integration.routes.js';
import { checkHealth, publicReport } from '../workers/health.js';
import { ok } from '../utils/respond.js';

const router = Router();

/**
 * Liveness and pipeline health, unauthenticated so an uptime probe can reach it.
 *
 * It calls the same `checkHealth()` the scheduled monitor runs rather than
 * defining a second idea of "healthy" that would drift from it. A degraded
 * pipeline still answers 200 — the endpoint reports status, it does not take
 * the API down because a scraper is behind.
 *
 * `publicReport` is the reason this can be public: the full report carries a
 * verbatim worker exception, and unauthenticated is the one place a Postgres
 * message must never reach.
 */
router.get('/health', async (_req, res) => {
  const report = await checkHealth();
  return ok(res, publicReport(report));
});

router.use('/auth', authRoutes);
router.use('/tenders', tenderRoutes);
router.use('/saved-searches', savedSearchRoutes);
router.use('/notifications', notificationRoutes);
router.use('/integrations', integrationRoutes);
// Mounted at the root so it can own /tenders/:id/benchmark alongside /benchmarks/:cpv.
router.use('/', intelligenceRoutes);

export default router;

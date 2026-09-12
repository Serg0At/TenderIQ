import { Router } from 'express';
import authRoutes from './auth/auth.routes.js';
import organizationRoutes from './organizations/organization.routes.js';
import tenderRoutes from './tenders/tender.routes.js';
import savedSearchRoutes from './savedSearches/savedSearch.routes.js';
import trackedTenderRoutes from './trackedTenders/trackedTender.routes.js';
import supplierIdentityRoutes from './trackedTenders/supplierIdentity.routes.js';
import vaultRoutes from './vault/vaultDocument.routes.js';
import notificationRoutes from './notifications/notification.routes.js';
import {
  tenderIntelligenceRoutes,
  benchmarkRoutes,
  competitionRoutes,
  supplierRoutes,
  buyerRoutes,
} from './intelligence/intelligence.routes.js';
import integrationRoutes from './integrations/integration.routes.js';
import unsubscribeRoutes from './unsubscribe/unsubscribe.routes.js';
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
router.use('/organizations', organizationRoutes);
router.use('/tenders', tenderRoutes);
router.use('/saved-searches', savedSearchRoutes);
router.use('/tracked-tenders', trackedTenderRoutes);
// The supplier identity lives under /organization rather than beside the
// pipeline: it is an org-level fact that bid outcomes happen to be the first
// consumer of, and it will outlive this feature folder.
router.use('/organization', supplierIdentityRoutes);
router.use('/vault-documents', vaultRoutes);
router.use('/notifications', notificationRoutes);
router.use('/integrations', integrationRoutes);

/**
 * Top-level and short, because this URL is printed inside an email and read by
 * a human: `/api/v1/unsubscribe` beside `/api/v1/integrations/email/:id`. It is
 * the unauthenticated half of the same switch the integrations routes own.
 */
router.use('/unsubscribe', unsubscribeRoutes);

// Intelligence spans five prefixes rather than one namespace, so it is mounted
// once per prefix. It must NOT be mounted at '/': a router there matches every
// unrouted path, so its auth gate ran before the 404 handler could and a typo
// answered 401 — or, for a Free plan, 402 "upgrade to reach this" about an
// endpoint that does not exist. The tender-scoped half goes after
// `tenderRoutes` so /tenders and /tenders/:id keep their own `tender:read`
// gate instead of inheriting the Pro-only one.
router.use('/tenders', tenderIntelligenceRoutes);
router.use('/benchmarks', benchmarkRoutes);
router.use('/competition', competitionRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/buyers', buyerRoutes);

export default router;

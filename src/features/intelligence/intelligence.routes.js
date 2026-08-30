import { Router } from 'express';
import IntelligenceController from './intelligence.controller.js';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  competitorPricesQuerySchema,
  expectedCompetitionQuerySchema,
} from '../../validations/schemas/intelligence.query.schema.js';

/**
 * `intelligence:read` is held by every role but ALSO plan-gated to Pro and
 * above — the reference is explicit that competitor intelligence is the reason
 * to upgrade. The authorize middleware enforces both, and answers 402 rather
 * than 403 when the plan is what blocks, so the client can offer an upgrade
 * instead of a dead end.
 *
 * Applied per route rather than as a router-level `use`: these routers share
 * their mount prefixes with other features, so a blanket gate would fire on
 * paths this feature does not own — including paths that exist nowhere, which
 * is how a typo starts answering 402 instead of 404.
 */
const gate = [authenticate, authorize('intelligence:read')];

/**
 * Mounted under /tenders, AFTER the tenders feature. Every route here is a
 * property of one tender, so the path belongs beside the tender rather than in
 * an /intelligence namespace the client would have to learn separately.
 */
export const tenderIntelligenceRoutes = Router();

tenderIntelligenceRoutes.get('/:id/benchmark', ...gate, IntelligenceController.tenderBenchmark);

// Competitor winning prices. Under /tenders/:id rather than a /competitors
// namespace because the answer is a property of one tender, and because it sits
// directly beside the benchmark panel in the UI.
tenderIntelligenceRoutes.get(
  '/:id/competitor-prices',
  ...gate,
  validate(competitorPricesQuerySchema, 'query'),
  IntelligenceController.competitorPrices
);

// The AI recommendation. A GET because it is a read, and it is safe to treat as
// one: the answer is cached in Redis under a hash of its own evidence, so
// repeat views of an unchanged tender cost nothing and a new award invalidates
// it automatically.
tenderIntelligenceRoutes.get(
  '/:id/price-recommendation',
  ...gate,
  IntelligenceController.priceRecommendation
);

/** Category benchmarks, keyed by CPV. */
export const benchmarkRoutes = Router();

benchmarkRoutes.get('/:cpv', ...gate, IntelligenceController.categoryBenchmark);

/**
 * Standalone so it can be asked about a category the client is CONSIDERING,
 * with no tender to hang it off — the pre-bid question rather than the
 * post-award one.
 */
export const competitionRoutes = Router();

competitionRoutes.get(
  '/',
  ...gate,
  validate(expectedCompetitionQuerySchema, 'query'),
  IntelligenceController.expectedCompetition
);

// Profiles. Both sides of the market are rows in `parties`, but they are two
// different products — a supplier profile is a COMPETITOR profile, which is
// what a customer subscribes for — so they get two paths rather than one
// /parties/:id that branches on role.
export const supplierRoutes = Router();
supplierRoutes.get('/:id/profile', ...gate, IntelligenceController.supplierProfile);

export const buyerRoutes = Router();
buyerRoutes.get('/:id/profile', ...gate, IntelligenceController.buyerProfile);

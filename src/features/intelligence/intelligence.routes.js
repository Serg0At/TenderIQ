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
 */
const gate = [authenticate, authorize('intelligence:read')];

export const tenderIntelligenceRoutes = Router();
tenderIntelligenceRoutes.get('/:id/benchmark', ...gate, IntelligenceController.tenderBenchmark);
tenderIntelligenceRoutes.get( '/:id/competitor-prices', ...gate, validate(competitorPricesQuerySchema, 'query'), IntelligenceController.competitorPrices);
// The AI recommendation. A GET because it is a read, and it is safe to treat as
// one: the answer is cached in Redis under a hash of its own evidence, so
// repeat views of an unchanged tender cost nothing and a new award invalidates
// it automatically.
tenderIntelligenceRoutes.get( '/:id/price-recommendation', ...gate, IntelligenceController.priceRecommendation);

/** Category benchmarks, keyed by CPV. */
export const benchmarkRoutes = Router();
benchmarkRoutes.get('/:cpv', ...gate, IntelligenceController.categoryBenchmark);

export const competitionRoutes = Router();
competitionRoutes.get( '/', ...gate, validate(expectedCompetitionQuerySchema, 'query'), IntelligenceController.expectedCompetition);

export const supplierRoutes = Router();
supplierRoutes.get('/:id/profile', ...gate, IntelligenceController.supplierProfile);

export const buyerRoutes = Router();
buyerRoutes.get('/:id/profile', ...gate, IntelligenceController.buyerProfile);

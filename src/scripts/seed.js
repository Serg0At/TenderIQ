
import { createId } from '@paralleldrive/cuid2';
import db, { closeDb } from '../libs/knex.js';
import organizations from '../repositories/organization.repo.js';
import { logger } from '../utils/logger.js';

/**
 * Reference data the application cannot function without.
 *
 * Roles also self-seed on first registration (a foreign key needs them), but
 * plans do not — and without them `planFor()` resolves every organization to
 * 'free', which silently gates `intelligence:read` off for ALL users including
 * owners. The product's whole paid tier would appear broken rather than
 * unconfigured, so this must run before anyone signs up.
 *
 * Idempotent: safe on every deploy.
 *
 * Prices are the spec's tiers (business/Pricing Strategy.md). The `features`
 * array is documentation for now — entitlement is decided by PLAN_GATED in
 * libs/permissions.js, which keys on the plan NAME. Renaming a plan here
 * without updating that list would remove access, so the names are the
 * contract.
 */
const PLANS = [
  { name: 'free', priceUsd: 0, features: ['discovery', 'alerts'] },
  { name: 'starter', priceUsd: 40, features: ['discovery', 'alerts', 'deadline-tracker'] },
  { name: 'pro', priceUsd: 115, features: ['discovery', 'alerts', 'relevance', 'intelligence', 'vault', 'pipeline'] },
  { name: 'business', priceUsd: 250, features: ['everything', 'multi-user', 'priority-support'] },
  { name: 'enterprise', priceUsd: 600, features: ['everything', 'consultant-mode', 'sla'] },
];

const seed = async () => {
  await organizations.ensureRoles();
  logger.info('[seed] roles ensured');

  for (const plan of PLANS) {
    const existing = await db('plans').where({ name: plan.name }).first();
    if (existing) {
      await db('plans')
        .where({ id: existing.id })
        .update({ price_usd: plan.priceUsd, features: plan.features });
    } else {
      await db('plans').insert({
        id: createId(),
        name: plan.name,
        price_usd: plan.priceUsd,
        features: plan.features,
      });
    }
  }

  const roles = Number((await db('roles').count('* as c').first()).c);
  const permissions = Number((await db('permissions').count('* as c').first()).c);
  const grants = Number((await db('role_permissions').count('* as c').first()).c);
  const plans = Number((await db('plans').count('* as c').first()).c);
  logger.info(
    `[seed] done — ${roles} roles, ${permissions} permissions, ${grants} grants, ${plans} plans`
  );
  return { roles, permissions, grants, plans };
};

try {
  await seed();
} catch (error) {
  logger.error(`[seed] failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

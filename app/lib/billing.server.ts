import prisma from "./db.server";
import { PLANS, type PlanKey } from "./plans";

export { PLANS, type PlanKey };

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function resetCycleIfStale(shopDomain: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { shopDomain } });
  if (!sub) return;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (sub.cycleStartAt < thirtyDaysAgo) {
    await prisma.subscription.update({
      where: { shopDomain },
      data: { ordersThisMonth: 0, cycleStartAt: new Date() },
    });
  }
}

export async function getOrCreateSubscription(shopDomain: string) {
  await resetCycleIfStale(shopDomain);
  return prisma.subscription.upsert({
    where: { shopDomain },
    create: { shopDomain, plan: "free", status: "active" },
    update: {},
  });
}

/**
 * Increments the monthly order counter.
 * Returns `allowed: false` when the merchant has hit their plan limit.
 * Call this before saving a risk result — skip processing if not allowed.
 */
export async function incrementOrderCount(shopDomain: string): Promise<{
  allowed: boolean;
  plan: PlanKey;
  ordersThisMonth: number;
  limit: number;
}> {
  await resetCycleIfStale(shopDomain);

  const sub = await prisma.subscription.upsert({
    where: { shopDomain },
    create: { shopDomain, plan: "free", status: "active", ordersThisMonth: 0 },
    update: {},
  });

  const plan = (sub.plan in PLANS ? sub.plan : "free") as PlanKey;
  const limit = PLANS[plan].limit;

  if (limit !== -1 && sub.ordersThisMonth >= limit) {
    return { allowed: false, plan, ordersThisMonth: sub.ordersThisMonth, limit };
  }

  const updated = await prisma.subscription.update({
    where: { shopDomain },
    data: { ordersThisMonth: { increment: 1 } },
  });

  return { allowed: true, plan, ordersThisMonth: updated.ordersThisMonth, limit };
}

/**
 * Activates a plan (after Shopify billing confirmation or downgrade to free).
 * Resets the monthly counter and cycle start date.
 */
export async function activatePlan(
  shopDomain: string,
  plan: PlanKey,
  shopifySubscriptionId?: string | null
): Promise<void> {
  await prisma.subscription.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      plan,
      status: "active",
      shopifySubscriptionId: shopifySubscriptionId ?? null,
      ordersThisMonth: 0,
      cycleStartAt: new Date(),
    },
    update: {
      plan,
      status: "active",
      shopifySubscriptionId: shopifySubscriptionId ?? null,
      ordersThisMonth: 0,
      cycleStartAt: new Date(),
    },
  });
}

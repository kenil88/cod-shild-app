import { PrismaClient } from "@prisma/client";
import type {
  CustomerHistory,
  PincodeStats,
  IpStats,
  RulesConfig,
  RiskResult,
  OrderInput,
} from "./riskEngine";
import { DEFAULT_RULES } from "./riskEngine";

const prisma = new PrismaClient();
export default prisma;

// ─── getCustomerHistory ───────────────────────────────────────────────────────
// Builds a CustomerHistory from the orders table.
// Matches by phone OR email so guest checkouts are covered too.

export async function getCustomerHistory(
  shopDomain: string,
  phone: string | null | undefined,
  email: string | null | undefined
): Promise<CustomerHistory> {
  if (!phone && !email) {
    return { rtoCount: 0, totalOrders: 0, uniqueAddresses: 0, recentOrderCount: 0 };
  }

  const orClauses: { phone?: string; email?: string }[] = [];
  if (phone) orClauses.push({ phone });
  if (email) orClauses.push({ email });

  const orders = await prisma.codOrder.findMany({
    where: { shopDomain, OR: orClauses },
    select: {
      rtoConfirmed: true,
      pincode: true,
      createdAt: true,
    },
  });

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rtoCount = orders.filter((o) => o.rtoConfirmed).length;
  const totalOrders = orders.length;
  const uniqueAddresses = new Set(orders.map((o) => o.pincode).filter(Boolean)).size;
  const recentOrderCount = orders.filter(
    (o) => o.createdAt > twentyFourHoursAgo
  ).length;

  return { rtoCount, totalOrders, uniqueAddresses, recentOrderCount };
}

// ─── getPincodeStats ──────────────────────────────────────────────────────────
// Returns pincode RTO stats for a given shop + pincode pair.

export async function getPincodeStats(
  shopDomain: string,
  pincode: string | null | undefined
): Promise<PincodeStats | null> {
  if (!pincode) return null;

  const row = await prisma.pincode.findUnique({
    where: { shopDomain_pincode: { shopDomain, pincode } },
  });

  if (!row) return null;

  return {
    totalOrders: row.totalOrders,
    rtoCount: row.rtoCount,
    rtoRate: row.rtoRate,
  };
}

// ─── getIpStats ───────────────────────────────────────────────────────────────
// Returns how many orders have come from this IP within the given window.

export async function getIpStats(
  shopDomain: string,
  ip: string | null | undefined,
  windowMinutes = 60
): Promise<IpStats | null> {
  if (!ip || ip === "0.0.0.0") return null;

  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  // Count orders from this IP within the velocity window
  const recentCount = await prisma.codOrder.count({
    where: { shopDomain, ip, createdAt: { gte: windowStart } },
  });

  // Get or create the persistent IP stat row
  const row = await prisma.ipStat.upsert({
    where: { shopDomain_ip: { shopDomain, ip } },
    create: { shopDomain, ip, orderCount: 1, flagCount: 0 },
    update: { orderCount: { increment: 1 }, lastSeenAt: new Date() },
  });

  return {
    orderCount: recentCount,
    flagCount: row.flagCount,
  };
}

// ─── getMerchantRules ─────────────────────────────────────────────────────────
// Loads per-merchant signal config. Falls back to DEFAULT_RULES if none saved.

export async function getMerchantRules(shopDomain: string): Promise<RulesConfig> {
  const row = await prisma.rule.findUnique({ where: { shopDomain } });
  if (!row) return DEFAULT_RULES;

  return {
    newCustomer: row.newCustomer,
    highRtoPincode: row.highRtoPincode,
    unusualQuantity: row.unusualQuantity,
    nightOrder: row.nightOrder,
    incompleteAddress: row.incompleteAddress,
    pastRtoHistory: row.pastRtoHistory,
    multipleAddresses: row.multipleAddresses,
    orderVelocity: row.orderVelocity,
    newCustomerWeight: row.newCustomerWeight,
    highRtoPincodeWeight: row.highRtoPincodeWeight,
    unusualQuantityWeight: row.unusualQuantityWeight,
    nightOrderWeight: row.nightOrderWeight,
    incompleteAddressWeight: row.incompleteAddressWeight,
    pastRtoHistoryWeight: row.pastRtoHistoryWeight,
    multipleAddressesWeight: row.multipleAddressesWeight,
    orderVelocityWeight: row.orderVelocityWeight,
    autoCancelThreshold: row.autoCancelThreshold,
    autoCancel: row.autoCancel,
  };
}

// ─── saveRiskResult ───────────────────────────────────────────────────────────
// Persists a scored order to the orders table. Also records a Saving row
// when the order is blocked (action = cancel).

export async function saveRiskResult(
  shopDomain: string,
  order: OrderInput,
  result: RiskResult
): Promise<string> {
  const isBlocked = result.action === "cancel";

  const saved = await prisma.codOrder.create({
    data: {
      shopDomain,
      shopifyOrderId: order.shopifyOrderId,
      orderNumber: order.orderNumber,
      customerId: order.customer?.id ?? null,
      phone: order.customer?.phone ?? order.shippingAddress?.phone ?? null,
      email: order.customer?.email ?? null,
      pincode: order.shippingAddress?.zip ?? null,
      ip: order.ip ?? null,
      orderValue: order.totalPrice,
      paymentMethod: order.paymentMethod,
      riskScore: result.score,
      riskLevel: result.level,
      action: result.action,
      signalsTriggered: result.triggeredSignals,
      isBlocked,
    },
  });

  // Record savings for blocked orders
  if (isBlocked && order.totalPrice > 0) {
    await prisma.saving.create({
      data: {
        shopDomain,
        orderId: saved.id,
        orderValue: order.totalPrice,
      },
    });
  }

  return saved.id;
}

// ─── updateCustomerHistory ────────────────────────────────────────────────────
// Increments Customer RTO flag when an order is confirmed as returned.
// Called after merchant clicks "Mark RTO" or via webhook.

export async function updateCustomerHistory(
  shopDomain: string,
  order: OrderInput
): Promise<void> {
  const customerId = order.customer?.id;
  if (!customerId) return;

  // Ensure merchant row exists
  await prisma.merchant.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });

  // Mark all matching orders for this customer as RTO confirmed
  await prisma.codOrder.updateMany({
    where: {
      shopDomain,
      customerId,
      shopifyOrderId: order.shopifyOrderId,
    },
    data: { rtoConfirmed: true },
  });
}

// ─── updatePincodeStats ───────────────────────────────────────────────────────
// Recalculates RTO rate for a pincode after each order is processed or
// confirmed as RTO. Called from the webhook handler.

export async function updatePincodeStats(
  shopDomain: string,
  order: OrderInput,
  isRto = false
): Promise<void> {
  const pincode = order.shippingAddress?.zip;
  if (!pincode) return;

  await prisma.pincode.upsert({
    where: { shopDomain_pincode: { shopDomain, pincode } },
    create: {
      shopDomain,
      pincode,
      totalOrders: 1,
      rtoCount: isRto ? 1 : 0,
      rtoRate: isRto ? 1 : 0,
    },
    update: {
      totalOrders: { increment: 1 },
      rtoCount: isRto ? { increment: 1 } : undefined,
    },
  });

  // Recalculate rate after upsert
  const row = await prisma.pincode.findUnique({
    where: { shopDomain_pincode: { shopDomain, pincode } },
  });

  if (row && row.totalOrders > 0) {
    await prisma.pincode.update({
      where: { shopDomain_pincode: { shopDomain, pincode } },
      data: { rtoRate: row.rtoCount / row.totalOrders },
    });
  }
}

// ─── ensureMerchant ───────────────────────────────────────────────────────────
// Creates a merchant row on first install. Called from the auth flow.

export async function ensureMerchant(
  shopDomain: string,
  shopName?: string,
  email?: string
): Promise<void> {
  await prisma.merchant.upsert({
    where: { shopDomain },
    create: { shopDomain, shopName, email },
    update: { shopName, email, isActive: true },
  });
}

// ─── getDashboardStats ────────────────────────────────────────────────────────
// Single query for all three dashboard stat cards.

export async function getDashboardStats(shopDomain: string): Promise<{
  totalOrders: number;
  blockedToday: number;
  moneySaved: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [totalOrders, blockedToday, savings] = await Promise.all([
    prisma.codOrder.count({ where: { shopDomain } }),
    prisma.codOrder.count({
      where: { shopDomain, isBlocked: true, createdAt: { gte: startOfDay } },
    }),
    prisma.saving.aggregate({
      where: { shopDomain },
      _sum: { orderValue: true },
    }),
  ]);

  return {
    totalOrders,
    blockedToday,
    moneySaved: savings._sum.orderValue ?? 0,
  };
}

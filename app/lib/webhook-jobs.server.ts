import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  getCustomerHistory,
  getPincodeStats,
  getIpStats,
  getMerchantRules,
  saveRiskResult,
  updatePincodeStats,
  updateCustomerHistory,
  ensureMerchant,
} from "./db.server";
import { scoreOrder, type OrderInput } from "./riskEngine";
import { getOrCreateSubscription, incrementOrderCount, isActiveSubscription } from "./billing.server";

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 5;
const COD_KEYWORDS = ["cash on delivery", "cod", "pay on delivery", "manual"];

let workerRunning = false;

type WebhookJobRow = {
  id: string;
  topic: string;
  shopDomain: string;
  payload: Prisma.JsonValue;
  status: string;
  attempts: number;
};

export async function enqueueWebhookJob({
  topic,
  shop,
  payload,
}: {
  topic: string;
  shop: string;
  payload: Prisma.InputJsonValue;
}) {
  const id = randomUUID();
  const payloadJson = JSON.stringify(payload);

  await prisma.$executeRaw`
    INSERT INTO "webhook_jobs" ("id", "topic", "shopDomain", "payload", "updatedAt")
    VALUES (${id}, ${topic}, ${shop}, ${payloadJson}::jsonb, NOW())
  `;

  scheduleWebhookJobDrain();
  return id;
}

export function scheduleWebhookJobDrain() {
  setTimeout(() => {
    void drainWebhookJobs();
  }, 0);
}

async function drainWebhookJobs() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    await prisma.$executeRaw`
      UPDATE "webhook_jobs"
      SET "status" = 'queued',
          "lockedAt" = NULL,
          "updatedAt" = NOW()
      WHERE "status" = 'processing'
        AND "lockedAt" < NOW() - INTERVAL '5 minutes'
        AND "attempts" < ${MAX_ATTEMPTS}
    `;

    await prisma.$executeRaw`
      DELETE FROM "webhook_jobs"
      WHERE "status" = 'completed'
        AND "updatedAt" < NOW() - INTERVAL '7 days'
    `;

    const jobs = await prisma.$queryRaw<WebhookJobRow[]>`
      SELECT "id", "topic", "shopDomain", "payload", "status", "attempts"
      FROM "webhook_jobs"
      WHERE "status" = 'queued' AND "attempts" < ${MAX_ATTEMPTS}
      ORDER BY "createdAt" ASC
      LIMIT ${BATCH_SIZE}
    `;

    for (const job of jobs) {
      const claimed = await prisma.$executeRaw`
        UPDATE "webhook_jobs"
        SET "status" = 'processing',
            "attempts" = "attempts" + 1,
            "lockedAt" = NOW(),
            "lastError" = NULL,
            "updatedAt" = NOW()
        WHERE "id" = ${job.id} AND "status" = 'queued'
      `;

      if (claimed === 0) continue;

      try {
        await processWebhookJob(job.topic, job.shopDomain, job.payload);
        await prisma.$executeRaw`
          UPDATE "webhook_jobs"
          SET "status" = 'completed',
              "lockedAt" = NULL,
              "updatedAt" = NOW()
          WHERE "id" = ${job.id}
        `;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const nextStatus = job.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "queued";
        await prisma.$executeRaw`
          UPDATE "webhook_jobs"
          SET "status" = ${nextStatus},
              "lockedAt" = NULL,
              "lastError" = ${message.slice(0, 1000)},
              "updatedAt" = NOW()
          WHERE "id" = ${job.id}
        `;
        console.error(`[COD Shield] Webhook job ${job.id} failed:`, err);
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function processWebhookJob(topic: string, shop: string, payload: Prisma.JsonValue) {
  if (topic === "orders/create") {
    await processOrderCreate(shop, payload);
    return;
  }

  if (topic === "orders/updated") {
    await processOrderUpdated(shop, payload);
  }
}

function isCOD(gatewayNames: string[]): boolean {
  return gatewayNames.some((g) =>
    COD_KEYWORDS.some((kw) => g.toLowerCase().includes(kw))
  );
}

const ORDER_QUERY = `#graphql
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      legacyResourceId
      createdAt
      paymentGatewayNames
      totalPriceSet { shopMoney { amount currencyCode } }
      clientIp
      lineItems(first: 50) { edges { node { quantity } } }
      customer {
        id
        legacyResourceId
        phone
        email
        numberOfOrders
      }
      shippingAddress {
        address1
        city
        zip
        provinceCode
        phone
      }
    }
  }
`;

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const ORDER_NOTE_MUTATION = `#graphql
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation CancelOrder(
    $orderId: ID!
    $reason: OrderCancelReason!
    $notifyCustomer: Boolean!
    $restock: Boolean!
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      notifyCustomer: $notifyCustomer
      restock: $restock
    ) {
      orderCancelUserErrors { field message }
    }
  }
`;

function asRecord(payload: Prisma.JsonValue): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function buildOrderInput(o: Record<string, unknown>): OrderInput {
  const lineItems = (
    (o.lineItems as { edges: { node: { quantity: number } }[] })?.edges ?? []
  ).map((e) => ({ quantity: e.node.quantity }));

  return {
    shopifyOrderId: o.id as string,
    orderNumber: ((o.name as string) ?? "").replace("#", ""),
    paymentMethod: ((o.paymentGatewayNames as string[]) ?? []).join(", "),
    totalPrice: parseFloat(
      (o.totalPriceSet as { shopMoney: { amount: string } })?.shopMoney?.amount ?? "0"
    ),
    lineItems,
    createdAt: (o.createdAt as string) ?? new Date().toISOString(),
    ip: (o.clientIp as string) ?? null,
    customer: o.customer
      ? {
          id: String((o.customer as { legacyResourceId: string }).legacyResourceId),
          phone: (o.customer as { phone?: string | null }).phone ?? null,
          email: (o.customer as { email?: string | null }).email ?? null,
          ordersCount: Number((o.customer as { numberOfOrders?: number }).numberOfOrders ?? 0),
        }
      : null,
    shippingAddress: o.shippingAddress
      ? {
          address1: (o.shippingAddress as { address1?: string }).address1 ?? null,
          city: (o.shippingAddress as { city?: string }).city ?? null,
          zip: (o.shippingAddress as { zip?: string }).zip ?? null,
          phone: (o.shippingAddress as { phone?: string | null }).phone ?? null,
        }
      : null,
  };
}

async function processOrderCreate(shop: string, payload: Prisma.JsonValue) {
  const rawPayload = asRecord(payload);
  const gatewayNamesFromPayload = (rawPayload.payment_gateway_names as string[]) ?? [];

  if (gatewayNamesFromPayload.length > 0 && !isCOD(gatewayNamesFromPayload)) {
    return;
  }

  const gid = rawPayload.admin_graphql_api_id as string | undefined;
  if (!gid) return;

  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
  const { data } = await res.json();
  const o = data?.order as Record<string, unknown> | null;

  if (!o) return;

  const gatewayNames = (o.paymentGatewayNames as string[]) ?? [];
  if (!isCOD(gatewayNames)) return;

  const order = buildOrderInput(o);
  const existing = await prisma.codOrder.findFirst({
    where: { shopDomain: shop, shopifyOrderId: order.shopifyOrderId },
    select: { id: true },
  });
  if (existing) return;

  const billing = await incrementOrderCount(shop);
  if (!billing.allowed) return;

  const phone = order.customer?.phone ?? order.shippingAddress?.phone ?? null;
  const email = order.customer?.email ?? null;
  const pincode = order.shippingAddress?.zip ?? null;
  const ip = order.ip ?? null;

  const [customerHistory, pincodeStats, ipStats, rules] = await Promise.all([
    getCustomerHistory(shop, phone, email),
    getPincodeStats(shop, pincode),
    getIpStats(shop, ip, 60),
    getMerchantRules(shop),
  ]);

  const result = scoreOrder(order, customerHistory, pincodeStats, ipStats, rules);
  const signalList = result.triggeredSignals.join(", ") || "none";
  const orderNote = `[COD Shield] Score: ${result.score}/100 | Risk: ${result.level.toUpperCase()} | Signals: ${signalList}`;

  await Promise.all([
    saveRiskResult(shop, order, result),
    updatePincodeStats(shop, order, false),
    ensureMerchant(shop),
    admin.graphql(ORDER_NOTE_MUTATION, { variables: { input: { id: gid, note: orderNote } } }),
  ]);

  if (result.level !== "safe" && billing.plan !== "free") {
    const tag = result.level === "high" ? "cod-high-risk" : "cod-medium-risk";
    await admin.graphql(TAG_MUTATION, {
      variables: { id: gid, tags: [tag, "cod-shield"] },
    });
  }

  const isGrowthPlus = billing.plan === "growth" || billing.plan === "scale";
  const isHighValue = order.totalPrice >= (rules.highValueThreshold ?? 5000);
  if (result.action === "cancel" && rules.autoCancel && isGrowthPlus && !isHighValue) {
    const cancelRes = await admin.graphql(CANCEL_MUTATION, {
      variables: {
        orderId: gid,
        reason: "FRAUD",
        notifyCustomer: false,
        restock: true,
      },
    });
    const cancelData = await cancelRes.json();
    const errors = cancelData?.data?.orderCancel?.orderCancelUserErrors ?? [];
    if (errors.length > 0) {
      throw new Error(`Cancel errors: ${JSON.stringify(errors)}`);
    }
  }
}

const RTO_TAG_SIGNALS = new Set([
  "rto",
  "returned",
  "failed delivery",
  "failed_delivery",
  "return_to_origin",
  "undelivered",
  "delivery failed",
]);

const RTO_TRACKING_STATUSES = [
  "returned",
  "return_to_origin",
  "rto",
  "delivery_failed",
  "failed_delivery",
  "undelivered",
];

const FORWARD_STATUSES = new Set([
  "fulfilled",
  "partial",
  "in_transit",
  "out_for_delivery",
  "attempted_delivery",
  "ready_for_pickup",
]);

function parseTags(rawTags: string): string[] {
  return rawTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function isRtoSignal(tags: string[], trackingStatus: string | null): boolean {
  if (tags.some((t) => RTO_TAG_SIGNALS.has(t))) return true;
  if (trackingStatus) {
    const s = trackingStatus.toLowerCase();
    if (RTO_TRACKING_STATUSES.some((r) => s.includes(r))) return true;
  }
  return false;
}

function isForwardShippingEvent(fulfillmentStatus: string | null, tags: string[]): boolean {
  if (!fulfillmentStatus) return false;
  return (
    FORWARD_STATUSES.has(fulfillmentStatus.toLowerCase()) &&
    !tags.some((t) => RTO_TAG_SIGNALS.has(t))
  );
}

async function processOrderUpdated(shop: string, payload: Prisma.JsonValue) {
  const raw = asRecord(payload);
  const gid = raw.admin_graphql_api_id as string | undefined;
  if (!gid) return;

  const tags = parseTags((raw.tags as string | undefined) ?? "");
  const fulfillmentStatus = (raw.fulfillment_status as string | null | undefined) ?? null;

  if (isForwardShippingEvent(fulfillmentStatus, tags)) return;
  if (!isRtoSignal(tags, fulfillmentStatus)) return;

  const sub = await getOrCreateSubscription(shop);
  if (!isActiveSubscription(sub) || sub.plan === "free") return;

  const codOrder = await prisma.codOrder.findFirst({
    where: { shopDomain: shop, shopifyOrderId: gid },
  });

  if (!codOrder || codOrder.rtoConfirmed) return;

  await prisma.codOrder.update({
    where: { id: codOrder.id },
    data: { rtoConfirmed: true },
  });

  const orderInput: OrderInput = {
    shopifyOrderId: codOrder.shopifyOrderId,
    orderNumber: codOrder.orderNumber,
    paymentMethod: codOrder.paymentMethod,
    totalPrice: codOrder.orderValue,
    lineItems: [],
    createdAt: codOrder.createdAt.toISOString(),
    customer: codOrder.customerId
      ? {
          id: codOrder.customerId,
          phone: codOrder.phone,
          email: codOrder.email,
          ordersCount: 0,
        }
      : null,
    shippingAddress: codOrder.pincode
      ? {
          address1: null,
          city: null,
          zip: codOrder.pincode,
          phone: codOrder.phone,
        }
      : null,
    ip: codOrder.ip,
  };

  await Promise.all([
    updateCustomerHistory(shop, orderInput),
    updatePincodeStats(shop, orderInput, true),
  ]);

  const { admin } = await unauthenticated.admin(shop);
  await admin.graphql(TAG_MUTATION, {
    variables: {
      id: gid,
      tags: ["cod-rto-confirmed", "cod-shield"],
    },
  });
}

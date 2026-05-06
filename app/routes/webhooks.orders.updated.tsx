import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { updateCustomerHistory, updatePincodeStats } from "../lib/db.server";
import { getOrCreateSubscription, isActiveSubscription } from "../lib/billing.server";
import type { OrderInput } from "../lib/riskEngine";

// ─── RTO detection ────────────────────────────────────────────────────────────

// Tags added by shipping aggregators (Shiprocket, Delhivery, Pickrr, etc.)
// Match is case-insensitive and exact per tag token.
const RTO_TAG_SIGNALS = new Set([
  "rto",
  "returned",
  "failed delivery",
  "failed_delivery",
  "return_to_origin",
  "undelivered",
  "delivery failed",
]);

// Carrier tracking statuses that confirm a physical return.
// These appear in fulfillment shipment_status when a shipping app syncs back.
const RTO_TRACKING_STATUSES = [
  "returned",
  "return_to_origin",
  "rto",
  "delivery_failed",
  "failed_delivery",
  "undelivered",
];

// Statuses that mean the order is still moving forward — never RTO.
// We bail early on these so high-volume transit updates are a no-op.
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

function isForwardShippingEvent(
  fulfillmentStatus: string | null,
  tags: string[]
): boolean {
  if (!fulfillmentStatus) return false;
  // Only short-circuit if it's a forward status AND no RTO tag is present
  return (
    FORWARD_STATUSES.has(fulfillmentStatus.toLowerCase()) &&
    !tags.some((t) => RTO_TAG_SIGNALS.has(t))
  );
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// ─── Webhook handler ──────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  console.log(`[COD Shield] ${topic} for ${shop}`);

  const raw = payload as {
    admin_graphql_api_id?: string;
    tags?: string;
    fulfillment_status?: string | null;
  };

  const gid = raw.admin_graphql_api_id;
  if (!gid) return new Response(null, { status: 200 });

  const tags = parseTags(raw.tags ?? "");
  const fulfillmentStatus = raw.fulfillment_status ?? null;

  // Fast-path: bail on high-volume forward shipping events with no RTO tag
  if (isForwardShippingEvent(fulfillmentStatus, tags)) {
    return new Response(null, { status: 200 });
  }

  // Only proceed if there is a confirmed RTO signal
  if (!isRtoSignal(tags, fulfillmentStatus)) {
    return new Response(null, { status: 200 });
  }

  try {
    // Auto RTO detection is a Starter+ feature
    const sub = await getOrCreateSubscription(shop);
    if (!isActiveSubscription(sub) || sub.plan === "free") {
      return new Response(null, { status: 200 });
    }

    // Find the CodOrder we recorded when this order was placed
    const codOrder = await prisma.codOrder.findFirst({
      where: { shopDomain: shop, shopifyOrderId: gid },
    });

    // Skip if we never tracked this order (prepaid) or already marked it
    if (!codOrder || codOrder.rtoConfirmed) {
      return new Response(null, { status: 200 });
    }

    // Mark RTO confirmed in our DB
    await prisma.codOrder.update({
      where: { id: codOrder.id },
      data: { rtoConfirmed: true },
    });

    // Build the minimal OrderInput needed for history + pincode updates
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

    // Update customer RTO history + pincode RTO rate in parallel
    await Promise.all([
      updateCustomerHistory(shop, orderInput),
      updatePincodeStats(shop, orderInput, true),
    ]);

    // Tag the Shopify order so it's visible in the admin
    if (admin) {
      await admin.graphql(TAG_MUTATION, {
        variables: {
          id: gid,
          tags: ["cod-rto-confirmed", "cod-shield"],
        },
      });
    }

    console.log(
      `[COD Shield] Auto-marked #${codOrder.orderNumber} as RTO` +
        ` (signals: tags=[${tags.join(", ")}] status=${fulfillmentStatus ?? "—"})`
    );
  } catch (err) {
    console.error("[COD Shield] orders/updated RTO error:", err);
  }

  return new Response(null, { status: 200 });
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getCustomerHistory,
  getPincodeStats,
  getIpStats,
  getMerchantRules,
  saveRiskResult,
  updatePincodeStats,
  ensureMerchant,
} from "../lib/db.server";
import { scoreOrder, type OrderInput } from "../lib/riskEngine";
import { incrementOrderCount } from "../lib/billing.server";

// ─── GraphQL queries / mutations ──────────────────────────────────────────────

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
      lineItems(first: 50) {
        edges { node { quantity } }
      }
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COD_KEYWORDS = ["cash on delivery", "cod", "pay on delivery", "manual"];

function isCOD(gatewayNames: string[]): boolean {
  return gatewayNames.some((g) =>
    COD_KEYWORDS.some((kw) => g.toLowerCase().includes(kw))
  );
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
      (o.totalPriceSet as { shopMoney: { amount: string } })?.shopMoney
        ?.amount ?? "0"
    ),
    lineItems,
    createdAt: (o.createdAt as string) ?? new Date().toISOString(),
    ip: (o.clientIp as string) ?? null,
    customer: o.customer
      ? {
          id: String(
            (o.customer as { legacyResourceId: string }).legacyResourceId
          ),
          phone:
            (o.customer as { phone?: string | null }).phone ?? null,
          email:
            (o.customer as { email?: string | null }).email ?? null,
          ordersCount: Number(
            (o.customer as { numberOfOrders?: number }).numberOfOrders ?? 0
          ),
        }
      : null,
    shippingAddress: o.shippingAddress
      ? {
          address1:
            (o.shippingAddress as { address1?: string }).address1 ?? null,
          city: (o.shippingAddress as { city?: string }).city ?? null,
          zip: (o.shippingAddress as { zip?: string }).zip ?? null,
          phone:
            (o.shippingAddress as { phone?: string | null }).phone ?? null,
        }
      : null,
  };
}

// ─── Webhook action ───────────────────────────────────────────────────────────
// Shopify requires a 200 response within 5 seconds.
// All DB queries run in parallel to stay well under that budget.

export const action = async ({ request }: ActionFunctionArgs) => {
  // authenticate.webhook verifies the HMAC signature automatically.
  // If the signature is invalid it throws, returning a 401.
  const { topic, shop, payload, admin } =
    await authenticate.webhook(request);

  console.log(`[COD Shield] ${topic} for ${shop}`);

  const rawPayload = payload as {
    admin_graphql_api_id?: string;
    payment_gateway_names?: string[];
  };

  // Fast-path: skip non-COD orders without any DB calls
  const gatewayNamesFromPayload = rawPayload.payment_gateway_names ?? [];
  if (
    gatewayNamesFromPayload.length > 0 &&
    !isCOD(gatewayNamesFromPayload)
  ) {
    console.log(`[COD Shield] Skipping prepaid order for ${shop}`);
    return new Response(null, { status: 200 });
  }

  const gid = rawPayload.admin_graphql_api_id;
  if (!gid || !admin) {
    console.warn("[COD Shield] Missing GID or admin client");
    return new Response(null, { status: 200 });
  }

  try {
    // 1. Fetch full order via authenticated GraphQL (protected data approved)
    const res = await admin.graphql(ORDER_QUERY, { variables: { id: gid } });
    const { data } = await res.json();
    const o = data?.order as Record<string, unknown> | null;

    if (!o) {
      console.warn(`[COD Shield] Could not fetch order ${gid}`);
      return new Response(null, { status: 200 });
    }

    // 2. Confirm COD from full order data
    const gatewayNames = (o.paymentGatewayNames as string[]) ?? [];
    if (!isCOD(gatewayNames)) {
      console.log(`[COD Shield] Prepaid order — skipping`);
      return new Response(null, { status: 200 });
    }

    const order = buildOrderInput(o);

    // 3. Enforce billing plan limit before doing any more work
    const billing = await incrementOrderCount(shop);
    if (!billing.allowed) {
      console.warn(
        `[COD Shield] ${shop} hit ${billing.plan} plan limit ` +
          `(${billing.ordersThisMonth}/${billing.limit}) — skipping order #${order.orderNumber}`
      );
      return new Response(null, { status: 200 });
    }

    const phone = order.customer?.phone ?? order.shippingAddress?.phone ?? null;
    const email = order.customer?.email ?? null;
    const pincode = order.shippingAddress?.zip ?? null;
    const ip = order.ip ?? null;

    // 5. Fetch all context in parallel — keeps total time < 1s
    const [customerHistory, pincodeStats, ipStats, rules] = await Promise.all([
      getCustomerHistory(shop, phone, email),
      getPincodeStats(shop, pincode),
      getIpStats(shop, ip, 60),
      getMerchantRules(shop),
    ]);

    // 6. Score the order
    const result = scoreOrder(order, customerHistory, pincodeStats, ipStats, rules);

    console.log(
      `[COD Shield] #${order.orderNumber} score=${result.score} ` +
        `level=${result.level} action=${result.action} ` +
        `signals=[${result.triggeredSignals.join(", ")}]`
    );

    // 7. Persist result + update pincode stats + add Shopify order note — all in parallel
    const signalList = result.triggeredSignals.join(", ") || "none";
    const orderNote = `[COD Shield] Score: ${result.score}/100 | Risk: ${result.level.toUpperCase()} | Signals: ${signalList}`;

    await Promise.all([
      saveRiskResult(shop, order, result),
      updatePincodeStats(shop, order, false),
      ensureMerchant(shop),
      admin.graphql(ORDER_NOTE_MUTATION, { variables: { input: { id: gid, note: orderNote } } }),
    ]);

    // 8. Auto-tag in Shopify (Starter+ only)
    if (result.level !== "safe" && billing.plan !== "free") {
      const tag =
        result.level === "high" ? "cod-high-risk" : "cod-medium-risk";
      await admin.graphql(TAG_MUTATION, {
        variables: { id: gid, tags: [tag, "cod-shield"] },
      });
    }

    // 9. Auto-cancel if action = cancel and merchant has it enabled (Growth+ only)
    // High-value orders are never auto-cancelled regardless of score.
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
      const errors =
        cancelData?.data?.orderCancel?.orderCancelUserErrors ?? [];
      if (errors.length > 0) {
        console.error("[COD Shield] Cancel errors:", errors);
      } else {
        console.log(`[COD Shield] Auto-cancelled order #${order.orderNumber}`);
      }
    }
  } catch (err) {
    // Log but always return 200 — Shopify retries on non-200
    console.error("[COD Shield] Webhook error:", err);
  }

  return new Response(null, { status: 200 });
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { scoreOrder, type OrderPayload } from "../risk.server";

const ORDER_QUERY = `#graphql
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      legacyResourceId
      paymentGatewayNames
      totalPriceSet { shopMoney { amount } }
      clientIp
      customer {
        id
        legacyResourceId
        phone
        numberOfOrders
      }
      shippingAddress {
        address1
        city
        provinceCode
        phone
      }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  console.log(`[COD Shield] Received ${topic} webhook for ${shop}`);

  // The raw payload only has the order ID (protected fields are redacted).
  // We re-fetch the full order via the authenticated GraphQL Admin API instead.
  const rawOrderId = (payload as { admin_graphql_api_id?: string; id?: number })
    .admin_graphql_api_id;

  if (!rawOrderId || !admin) {
    console.warn("[COD Shield] Missing order ID or admin client — skipping");
    return new Response(null, { status: 200 });
  }

  try {
    const res = await admin.graphql(ORDER_QUERY, {
      variables: { id: rawOrderId },
    });
    const { data } = await res.json();
    const o = data?.order;

    if (!o) {
      console.warn(`[COD Shield] Could not fetch order ${rawOrderId}`);
      return new Response(null, { status: 200 });
    }

    const orderPayload: OrderPayload = {
      id: Number(o.legacyResourceId),
      order_number: Number(o.name?.replace("#", "") ?? o.legacyResourceId),
      payment_gateway: (o.paymentGatewayNames ?? []).join(", "),
      total_price: o.totalPriceSet?.shopMoney?.amount ?? "0",
      browser_ip: o.clientIp ?? null,
      customer: o.customer
        ? {
            id: Number(o.customer.legacyResourceId),
            phone: o.customer.phone ?? null,
            orders_count: Number(o.customer.numberOfOrders ?? 0),
          }
        : null,
      shipping_address: o.shippingAddress
        ? {
            address1: o.shippingAddress.address1 ?? "",
            city: o.shippingAddress.city ?? "",
            province: o.shippingAddress.provinceCode ?? "",
            phone: o.shippingAddress.phone ?? null,
          }
        : null,
    };

    const { score, level, recommendation } = await scoreOrder(orderPayload);

    await db.orderRisk.create({
      data: {
        orderId: String(orderPayload.order_number),
        score,
        level,
        recommendation,
      },
    });

    if (o.customer?.legacyResourceId) {
      await db.customer.upsert({
        where: { id: String(o.customer.legacyResourceId) },
        create: {
          id: String(o.customer.legacyResourceId),
          phone: o.customer.phone ?? null,
          pastRTO: false,
        },
        update: {
          phone: o.customer.phone ?? undefined,
        },
      });
    }

    console.log(
      `[COD Shield] Order #${orderPayload.order_number} → score=${score} level=${level}`
    );
  } catch (err) {
    console.error("[COD Shield] Error processing order webhook:", err);
  }

  return new Response(null, { status: 200 });
};

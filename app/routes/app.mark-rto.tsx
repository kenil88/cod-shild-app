import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { updateCustomerHistory, updatePincodeStats } from "../lib/db.server";

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const codOrderId = String(form.get("codOrderId") ?? "");

  if (!codOrderId) return { ok: false };

  const order = await prisma.codOrder.findUnique({ where: { id: codOrderId } });
  if (!order) return { ok: false };

  // Security: only the shop that owns this order may mark it
  if (order.shopDomain !== session.shop) return { ok: false };

  // Mark order as RTO confirmed
  await prisma.codOrder.update({
    where: { id: codOrderId },
    data: { rtoConfirmed: true },
  });

  // Build minimal OrderInput for history + pincode updates
  const orderInput = {
    shopifyOrderId: order.shopifyOrderId,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod,
    totalPrice: order.orderValue,
    lineItems: [],
    createdAt: order.createdAt.toISOString(),
    customer: order.customerId ? { id: order.customerId, phone: order.phone, email: order.email, ordersCount: 0 } : null,
    shippingAddress: order.pincode ? { address1: null, city: null, zip: order.pincode, phone: order.phone } : null,
    ip: order.ip,
  };

  await Promise.all([
    updateCustomerHistory(session.shop, orderInput),
    updatePincodeStats(session.shop, orderInput, true),
  ]);

  // Tag order in Shopify
  if (order.shopifyOrderId) {
    await admin.graphql(TAG_MUTATION, {
      variables: { id: order.shopifyOrderId, tags: ["cod-rto-confirmed", "cod-shield"] },
    });
  }

  return { ok: true };
};

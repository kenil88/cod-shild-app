import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// GDPR mandatory webhook — customers/data_request
// Shopify sends this when a merchant's customer requests their stored data.
// We store: order risk scores, phone/email, IP, pincode linked to their orders.
// The merchant (controller) is responsible for fulfilling the data request.
// We (processor) must acknowledge and return within 30 days if queried.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[COD Shield] ${topic} for ${shop}`);
  console.log("[COD Shield] Data request payload:", JSON.stringify(payload));
  // No action required on our side — the merchant handles this with the customer.
  // COD Shield stores only order-level fraud signals (not browsing/preference data).
  return new Response(null, { status: 200 });
};

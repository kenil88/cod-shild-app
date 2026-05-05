import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory webhook — customers/redact
// Shopify sends this 10 days after a merchant or customer requests deletion.
// We must erase any PII stored for the customer.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[COD Shield] ${topic} for ${shop}`);

  const raw = payload as {
    customer?: { id?: number; email?: string; phone?: string };
  };

  const customerId = raw.customer?.id ? String(raw.customer.id) : null;
  const email = raw.customer?.email ?? null;
  const phone = raw.customer?.phone
    ? raw.customer.phone.replace(/\D/g, "").slice(-10)
    : null;

  try {
    // Anonymise PII fields on matching COD orders — keep risk signals for fraud model
    if (customerId || email || phone) {
      const orClauses: { customerId?: string; email?: string; phone?: string }[] = [];
      if (customerId) orClauses.push({ customerId });
      if (email) orClauses.push({ email });
      if (phone) orClauses.push({ phone });

      await prisma.codOrder.updateMany({
        where: { shopDomain: shop, OR: orClauses },
        data: { customerId: null, email: null, phone: null, ip: null },
      });
    }

    console.log(`[COD Shield] Redacted customer data for shop=${shop} customerId=${customerId}`);
  } catch (err) {
    console.error("[COD Shield] customers/redact error:", err);
  }

  return new Response(null, { status: 200 });
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory webhook — shop/redact
// Shopify sends this 90 days after a merchant uninstalls the app.
// We must delete all data associated with the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[COD Shield] ${topic} for ${shop}`);

  try {
    // Delete all shop data in dependency order
    await prisma.$transaction([
      prisma.saving.deleteMany({ where: { shopDomain: shop } }),
      prisma.ipStat.deleteMany({ where: { shopDomain: shop } }),
      prisma.pincode.deleteMany({ where: { shopDomain: shop } }),
      prisma.codOrder.deleteMany({ where: { shopDomain: shop } }),
      prisma.subscription.deleteMany({ where: { shopDomain: shop } }),
      prisma.rule.deleteMany({ where: { shopDomain: shop } }),
      prisma.merchant.deleteMany({ where: { shopDomain: shop } }),
      prisma.session.deleteMany({ where: { shop } }),
    ]);

    console.log(`[COD Shield] Erased all data for shop=${shop}`);
  } catch (err) {
    console.error("[COD Shield] shop/redact error:", err);
  }

  return new Response(null, { status: 200 });
};

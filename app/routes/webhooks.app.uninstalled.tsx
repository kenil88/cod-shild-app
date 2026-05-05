import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[COD Shield] ${topic} for ${shop}`);

  // Delete sessions so the merchant must re-install to get a fresh auth token
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Soft-deactivate the merchant row — full erasure happens via shop/redact (90 days later)
  await db.merchant.updateMany({
    where: { shopDomain: shop },
    data: { isActive: false },
  });

  return new Response(null, { status: 200 });
};

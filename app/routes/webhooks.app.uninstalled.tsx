import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[COD Shield] ${topic} for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  await db.$executeRaw`DELETE FROM "webhook_jobs" WHERE "shopDomain" = ${shop}`;

  await db.merchant.updateMany({
    where: { shopDomain: shop },
    data: { isActive: false },
  });

  return new Response(null, { status: 200 });
};

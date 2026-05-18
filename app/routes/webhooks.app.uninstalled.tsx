import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendFarewellEmail } from "../lib/email.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[COD King] ${topic} for ${shop}`);

  // Fetch merchant record before any cleanup so we have the email
  const merchant = await db.merchant.findUnique({
    where: { shopDomain: shop },
    select: { email: true, shopName: true },
  });

  // Fall back to the stored online session if merchant record has no email
  let email = merchant?.email ?? null;
  let firstName = "";
  let lastName = "";

  if (!email) {
    const ownerSession = await db.session.findFirst({
      where: { shop, accountOwner: true },
      select: { email: true, firstName: true, lastName: true },
    });
    email = ownerSession?.email ?? null;
    firstName = ownerSession?.firstName ?? "";
    lastName = ownerSession?.lastName ?? "";
  } else {
    const parts = (merchant?.shopName ?? "").split(" ");
    firstName = parts[0] ?? "";
    lastName = parts.slice(1).join(" ");
  }

  // Cleanup
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  await db.$executeRaw`DELETE FROM "webhook_jobs" WHERE "shopDomain" = ${shop}`;

  await db.merchant.updateMany({
    where: { shopDomain: shop },
    data: { isActive: false, onboardingCompleted: false },
  });

  // Reset subscription so reinstall always goes through billing selection again.
  // Shopify cancels the AppSubscription on uninstall — our DB must reflect that.
  await db.subscription.updateMany({
    where: { shopDomain: shop },
    data: { status: "cancelled", shopifySubscriptionId: null, plan: "free" },
  });

  // Send farewell email (best-effort, never block the 200 response)
  if (email) {
    sendFarewellEmail({ to: email, firstName, lastName }).catch((err) =>
      console.error("[COD King] Farewell email failed:", err)
    );
  }

  return new Response(null, { status: 200 });
};

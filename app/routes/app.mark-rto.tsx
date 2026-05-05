import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const riskId = String(form.get("riskId") ?? "");
  const shopifyOrderGid = String(form.get("shopifyOrderGid") ?? "");
  const shopifyCustomerGid = String(form.get("shopifyCustomerGid") ?? "");

  if (!riskId) {
    return { ok: false, error: "Missing riskId" };
  }

  // Mark the order risk record as RTO confirmed
  await prisma.orderRisk.update({
    where: { id: riskId },
    data: { rtoConfirmed: true },
  });

  // Flag the customer as past RTO so future orders score higher
  if (shopifyCustomerGid) {
    const legacyId = shopifyCustomerGid.split("/").pop() ?? "";
    if (legacyId) {
      await prisma.customer.upsert({
        where: { id: legacyId },
        create: { id: legacyId, pastRTO: true },
        update: { pastRTO: true },
      });
    }
  }

  // Tag the order in Shopify
  if (shopifyOrderGid) {
    await admin.graphql(TAG_MUTATION, {
      variables: {
        id: shopifyOrderGid,
        tags: ["cod-rto-confirmed", "cod-shield"],
      },
    });
  }

  return { ok: true };
};

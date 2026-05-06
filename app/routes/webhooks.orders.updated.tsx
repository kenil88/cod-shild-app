import type { ActionFunctionArgs } from "react-router";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { enqueueWebhookJob } from "../lib/webhook-jobs.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  await enqueueWebhookJob({
    topic,
    shop,
    payload: payload as Prisma.InputJsonValue,
  });

  return new Response(null, { status: 200 });
};

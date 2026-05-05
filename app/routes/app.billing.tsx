import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, type PlanKey } from "../lib/plans";
import { getOrCreateSubscription, activatePlan } from "../lib/billing.server";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const CREATE_SUBSCRIPTION = `#graphql
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      lineItems: $lineItems
    ) {
      userErrors { field message }
      confirmationUrl
      appSubscription { id name status }
    }
  }
`;

const VERIFY_SUBSCRIPTION = `#graphql
  query VerifySubscription($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        name
        status
      }
    }
  }
`;

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Handle return from Shopify billing page (charge_id in query string)
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  if (chargeId) {
    try {
      const res = await admin.graphql(VERIFY_SUBSCRIPTION, {
        variables: { id: chargeId },
      });
      const { data } = await res.json();
      const node = data?.node as { id: string; name: string; status: string } | null;

      if (node?.status === "ACTIVE") {
        const planKey = node.name.toLowerCase() as PlanKey;
        if (planKey in PLANS) {
          await activatePlan(shop, planKey, chargeId);
        }
      }
    } catch (e) {
      console.error("[COD Shield] Subscription verification failed:", e);
    }
    throw redirect("/app/billing");
  }

  const sub = await getOrCreateSubscription(shop);
  const plan = (sub.plan in PLANS ? sub.plan : "free") as PlanKey;
  const limit = PLANS[plan].limit;
  const usagePct =
    limit === -1 ? 0 : Math.min(100, (sub.ordersThisMonth / limit) * 100);

  return {
    plan,
    status: sub.status,
    ordersThisMonth: sub.ordersThisMonth,
    limit,
    usagePct,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const plan = form.get("plan") as PlanKey;

  if (!plan || !(plan in PLANS)) {
    return { confirmationUrl: null, error: "Invalid plan selected." };
  }

  // Downgrade to free — no Shopify charge needed
  if (plan === "free") {
    await activatePlan(shop, "free", null);
    return { confirmationUrl: null, error: null, downgraded: true };
  }

  // Paid plan: create Shopify recurring subscription
  const origin = new URL(request.url).origin;
  const returnUrl = `${origin}/app/billing`;

  const res = await admin.graphql(CREATE_SUBSCRIPTION, {
    variables: {
      name: PLANS[plan].name,
      returnUrl,
      // test: true lets you approve without a real credit card in development.
      // Set to false (or remove) before going live.
      test: true,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: String(PLANS[plan].price), currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    },
  });

  const { data } = await res.json();
  const result = data?.appSubscriptionCreate;

  if (result?.userErrors?.length > 0) {
    return { confirmationUrl: null, error: result.userErrors[0].message };
  }

  return {
    confirmationUrl: (result?.confirmationUrl as string) ?? null,
    error: null,
  };
};

// ─── Plan feature lists ───────────────────────────────────────────────────────

const FEATURES: Record<PlanKey, string[]> = {
  free: [
    "50 COD orders / month",
    "All 8 risk signals",
    "Risk dashboard",
    "Manual RTO marking",
  ],
  starter: [
    "500 COD orders / month",
    "All 8 risk signals",
    "Auto-tagging in Shopify",
    "Auto RTO detection",
  ],
  growth: [
    "2,000 COD orders / month",
    "Everything in Starter",
    "Auto-cancel high-risk orders",
    "Pincode RTO analytics",
  ],
  scale: [
    "Unlimited COD orders",
    "Everything in Growth",
    "Priority support",
    "Custom signal weights",
  ],
};

// ─── Billing page ─────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { plan: currentPlan, ordersThisMonth, limit, usagePct } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isLoading = fetcher.state !== "idle";
  const submittedPlan = fetcher.formData?.get("plan") as string | null;
  const error = fetcher.data?.error;

  // Escape the Shopify iframe and navigate to Shopify's billing confirmation page
  useEffect(() => {
    const url = fetcher.data?.confirmationUrl;
    if (url) {
      (window.top ?? window).location.href = url;
    }
  }, [fetcher.data]);

  return (
    <s-page heading="COD Shield — Billing">
      {/* ── Usage bar ── */}
      <s-section heading="This Month's Usage">
        <div style={{ maxWidth: 500 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 700 }}>
              {PLANS[currentPlan].name} Plan
            </span>
            <span style={{ color: "#6d7175" }}>
              {ordersThisMonth.toLocaleString()} /{" "}
              {limit === -1 ? "∞" : limit.toLocaleString()} orders
            </span>
          </div>
          <div
            style={{
              height: 10,
              borderRadius: 5,
              background: "#e4e5e7",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${limit === -1 ? 0 : usagePct}%`,
                height: "100%",
                borderRadius: 5,
                background:
                  usagePct >= 90
                    ? "#d72c0d"
                    : usagePct >= 70
                    ? "#b98900"
                    : "#008060",
                transition: "width 0.4s",
              }}
            />
          </div>
          {limit !== -1 && usagePct >= 80 && (
            <p
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "#d72c0d",
                fontWeight: 600,
              }}
            >
              You've used {Math.round(usagePct)}% of your monthly limit.
              Upgrade to avoid missing COD orders.
            </p>
          )}
          {limit !== -1 && usagePct >= 100 && (
            <p
              style={{
                marginTop: 4,
                fontSize: 12,
                color: "#d72c0d",
                fontWeight: 700,
              }}
            >
              Limit reached — new COD orders are no longer being scored.
              Upgrade now to resume protection.
            </p>
          )}
        </div>
      </s-section>

      {/* ── Error banner ── */}
      {error && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#fff8f8",
              border: "1px solid #ffd2cc",
              borderRadius: 8,
              color: "#d72c0d",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        </s-section>
      )}

      {/* ── Plan cards ── */}
      <s-section heading="Plans">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
          }}
        >
          {(Object.keys(PLANS) as PlanKey[]).map((key) => {
            const p = PLANS[key];
            const isCurrent = key === currentPlan;
            const isPopular = key === "growth";

            return (
              <div
                key={key}
                style={{
                  border: isCurrent
                    ? "2px solid #008060"
                    : isPopular
                    ? "2px solid #b98900"
                    : "1px solid #e4e5e7",
                  borderRadius: 12,
                  padding: "24px 18px 18px",
                  background: isCurrent ? "#f4fff8" : "#fff",
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {/* Badge */}
                {(isCurrent || isPopular) && (
                  <span
                    style={{
                      position: "absolute",
                      top: -13,
                      left: "50%",
                      transform: "translateX(-50%)",
                      background: isCurrent ? "#008060" : "#b98900",
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "2px 14px",
                      borderRadius: 20,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isCurrent ? "CURRENT PLAN" : "BEST VALUE"}
                  </span>
                )}

                {/* Price */}
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: "#1a1a1a" }}>
                    {p.name}
                  </div>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 900,
                      color: isCurrent ? "#008060" : "#1a1a1a",
                      margin: "6px 0 2px",
                      lineHeight: 1,
                    }}
                  >
                    {p.price === 0 ? "Free" : `$${p.price}`}
                    {p.price > 0 && (
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: "#6d7175",
                        }}
                      >
                        /mo
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "#6d7175" }}>
                    {p.limit === -1
                      ? "Unlimited orders"
                      : `${p.limit.toLocaleString()} orders / month`}
                  </div>
                </div>

                {/* Features */}
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                    flexGrow: 1,
                  }}
                >
                  {FEATURES[key].map((f) => (
                    <li
                      key={f}
                      style={{
                        fontSize: 12,
                        color: "#3d4147",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 7,
                      }}
                    >
                      <span
                        style={{
                          color: "#008060",
                          fontWeight: 800,
                          flexShrink: 0,
                          marginTop: 1,
                        }}
                      >
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <fetcher.Form method="POST">
                  <input type="hidden" name="plan" value={key} />
                  {(() => {
                    const isThisLoading = isLoading && submittedPlan === key;
                    return (
                      <button
                        type="submit"
                        disabled={isCurrent || isLoading}
                        style={{
                          width: "100%",
                          padding: "11px 0",
                          borderRadius: 8,
                          background: isCurrent
                            ? "#e4e5e7"
                            : key === "free"
                            ? "#f6f6f7"
                            : "#008060",
                          color: isCurrent
                            ? "#8c9196"
                            : key === "free"
                            ? "#6d7175"
                            : "#fff",
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: isCurrent || isLoading ? "default" : "pointer",
                          opacity: isThisLoading ? 0.75 : 1,
                          border:
                            key === "free" && !isCurrent
                              ? "1px solid #e4e5e7"
                              : "none",
                        }}
                      >
                        {isCurrent
                          ? "Current Plan"
                          : key === "free"
                          ? "Downgrade to Free"
                          : isThisLoading
                          ? "Redirecting to Shopify..."
                          : `Upgrade to ${p.name}`}
                      </button>
                    );
                  })()}
                </fetcher.Form>
              </div>
            );
          })}
        </div>
      </s-section>

      {/* ── FAQ ── */}
      <s-section slot="aside" heading="About Billing">
        <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13 }}>
          <FaqItem
            q="What counts as an order?"
            a="Only COD orders that COD Shield analyzes count toward your limit. Prepaid orders are never counted."
          />
          <FaqItem
            q="When does my count reset?"
            a="Your order count resets every 30 days from your last plan activation."
          />
          <FaqItem
            q="What happens when I hit the limit?"
            a="New COD orders stop being scored until the next cycle or you upgrade. Existing orders are unaffected."
          />
          <FaqItem
            q="Can I downgrade anytime?"
            a="Yes, downgrading to Free takes effect immediately with a fresh 30-day cycle."
          />
        </div>
      </s-section>
    </s-page>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <div style={{ fontWeight: 700, color: "#1a1a1a", marginBottom: 3 }}>{q}</div>
      <div style={{ color: "#6d7175", lineHeight: 1.5 }}>{a}</div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

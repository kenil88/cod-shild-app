import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { PLANS, type PlanKey } from "../lib/plans";
import { activatePlan, getSubscription, isActiveSubscription } from "../lib/billing.server";
import { sendPlanUpgradeEmail } from "../lib/email.server";
import prisma from "../db.server";

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


const CANCEL_SUBSCRIPTION = `#graphql
  mutation AppSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      userErrors { field message }
      appSubscription { id status }
    }
  }
`;

const GET_ACTIVE_SUBSCRIPTIONS = `#graphql
  query GetActiveSubscriptions {
    currentAppInstallation {
      app {
        handle
      }
      activeSubscriptions {
        id
        name
        status
        test
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
    let billingDeclined = false;
    try {
      // Use activeSubscriptions query — more reliable than node(id: chargeId) since
      // Shopify may return a numeric or GID charge_id depending on API version.
      const res = await admin.graphql(GET_ACTIVE_SUBSCRIPTIONS);
      const { data } = await res.json();
      const activeSubs = (data?.currentAppInstallation?.activeSubscriptions ?? []) as Array<{
        id: string; name: string; status: string;
      }>;

      if (activeSubs.length > 0) {
        const shopifySub = activeSubs[0];
        const planKey = shopifySub.name.toLowerCase() as PlanKey;
        if (planKey in PLANS) {
          await activatePlan(shop, planKey, shopifySub.id);

          // Send upgrade confirmation email (best-effort)
          const merchant = await prisma.merchant.findUnique({
            where: { shopDomain: shop },
            select: { email: true, shopName: true },
          });
          if (merchant?.email) {
            const parts = (merchant.shopName ?? "").split(" ");
            sendPlanUpgradeEmail({
              to: merchant.email,
              firstName: parts[0] ?? "",
              lastName: parts.slice(1).join(" "),
              plan: planKey,
              price: PLANS[planKey].price,
            }).catch((err) => console.error("[COD King] Upgrade email failed:", err));
          }
        }
      } else {
        // No active subscription on Shopify side — billing was declined or not completed
        billingDeclined = true;
        const existing = await getSubscription(shop);
        if (!isActiveSubscription(existing)) {
          await activatePlan(shop, "free", null);
        }
      }
    } catch (e) {
      console.error("[COD Shield] Subscription verification failed:", e);
    }
    throw redirect(billingDeclined ? "/app/billing?billing_status=declined" : "/app/billing");
  }

  const billingStatus = url.searchParams.get("billing_status");

  // Read subscription from DB and sync with Shopify's actual billing state
  let sub = await getSubscription(shop);
  let managedPricingUrl: string | null = null;
  try {
    const res = await admin.graphql(GET_ACTIVE_SUBSCRIPTIONS);
    const { data } = await res.json();
    const installation = data?.currentAppInstallation;
    const activeSubs = (installation?.activeSubscriptions ?? []) as Array<{
      id: string; name: string; status: string;
    }>;

    // Build the Shopify admin billing URL for this app using the app handle
    const appHandle = installation?.app?.handle as string | null;
    if (appHandle) {
      const shopHandle = shop.replace(".myshopify.com", "");
      managedPricingUrl = `https://admin.shopify.com/store/${shopHandle}/settings/apps/app_installations/app/${appHandle}`;
    }

    if (activeSubs.length === 0) {
      // Shopify has no active subscription — reset to free UNLESS it's a dev bypass activation
      const isDevBypass = sub?.shopifySubscriptionId?.startsWith("dev-bypass-");
      if (sub && sub.plan !== "free" && sub.status === "active" && !isDevBypass) {
        await activatePlan(shop, "free", null);
        sub = await getSubscription(shop);
      }
    } else {
      // Shopify has an active subscription — sync DB if out of date
      const shopifySub = activeSubs[0];
      const planKey = shopifySub.name.toLowerCase() as PlanKey;
      if (planKey in PLANS && planKey !== "free") {
        const needsSync =
          !sub ||
          sub.plan !== planKey ||
          sub.status !== "active" ||
          sub.shopifySubscriptionId !== shopifySub.id;
        if (needsSync) {
          await activatePlan(shop, planKey, shopifySub.id);
          sub = await getSubscription(shop);
        }
      }
    }
  } catch (e) {
    console.error("[COD Shield] Subscription sync failed:", e);
  }

  const hasActiveSubscription = isActiveSubscription(sub);
  const plan = sub && sub.plan in PLANS ? (sub.plan as PlanKey) : "free";
  const limit = PLANS[plan].limit;
  const usagePct =
    limit === -1 || !sub ? 0 : Math.min(100, (sub.ordersThisMonth / limit) * 100);

  return {
    plan,
    status: sub?.status ?? "none",
    hasActiveSubscription,
    ordersThisMonth: sub?.ordersThisMonth ?? 0,
    limit,
    usagePct,
    billingDeclined: billingStatus === "declined",
    managedPricingUrl,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const plan = form.get("plan") as PlanKey;

  if (!plan || !(plan in PLANS)) {
    return { confirmationUrl: null, error: "Invalid plan selected.", devActivated: null };
  }

  // Cancel any existing Shopify subscription before switching plans
  const existingSub = await getSubscription(shop);
  if (existingSub?.shopifySubscriptionId) {
    try {
      await admin.graphql(CANCEL_SUBSCRIPTION, {
        variables: { id: existingSub.shopifySubscriptionId },
      });
    } catch (e) {
      console.error("[COD Shield] Failed to cancel existing subscription:", e);
    }
  }

  // Downgrade to free — no Shopify charge needed
  if (plan === "free") {
    await activatePlan(shop, "free", null);
    return { confirmationUrl: null, error: null, downgraded: true, devActivated: null };
  }

  // Dev bypass: activates plan directly for listed stores (comma-separated DEV_BILLING_BYPASS_STORE)
  // Safe in production — only named dev stores are bypassed, real merchant stores never match
  const bypassStores = (process.env.DEV_BILLING_BYPASS_STORE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (bypassStores.includes(shop)) {
    await activatePlan(shop, plan, `dev-bypass-${Date.now()}`);
    return { confirmationUrl: null, error: null, devActivated: plan, managedPricing: false };
  }

  // Paid plan: create Shopify recurring subscription
  const origin = new URL(request.url).origin;
  const returnUrl = `${origin}/app/billing`;

  const res = await admin.graphql(CREATE_SUBSCRIPTION, {
    variables: {
      name: PLANS[plan].name,
      returnUrl,
      test: process.env.NODE_ENV !== "production",
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
    const errMsg = result.userErrors[0].message as string;
    // Managed Pricing apps can't use the Billing API — signal the UI to redirect
    if (errMsg.includes("Managed Pricing") || errMsg.includes("managed pricing")) {
      return { confirmationUrl: null, error: null, devActivated: null, managedPricing: true };
    }
    return { confirmationUrl: null, error: errMsg, devActivated: null };
  }

  return {
    confirmationUrl: (result?.confirmationUrl as string) ?? null,
    error: null,
    devActivated: null,
    managedPricingUrl: null,
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
  const { plan: currentPlan, status, hasActiveSubscription, ordersThisMonth, limit, usagePct, billingDeclined, managedPricingUrl } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { revalidate } = useRevalidator();
  const isLoading = fetcher.state !== "idle";
  const submittedPlan = fetcher.formData?.get("plan") as string | null;
  const error = fetcher.data?.error;
  const [managedPricingBlocked, setManagedPricingBlocked] = useState(false);

  // Escape the Shopify iframe and navigate to Shopify's billing confirmation page
  useEffect(() => {
    const url = fetcher.data?.confirmationUrl;
    if (url) {
      (window.top ?? window).location.href = url;
    }
  }, [fetcher.data]);

  // For Managed Pricing apps:
  // - Live (App Store listed) stores: redirect to Shopify admin billing page where plans are selectable
  // - Unlisted dev stores (no managedPricingUrl): show in-app banner with dev instructions
  useEffect(() => {
    if (fetcher.data?.managedPricing) {
      if (managedPricingUrl) {
        shopify.toast.show("Opening Shopify billing to change your plan…");
        (window.top ?? window).location.href = managedPricingUrl;
      } else {
        setManagedPricingBlocked(true);
      }
    }
  }, [fetcher.data, managedPricingUrl, shopify]);

  // Show toast on successful downgrade to free and refresh loader data
  useEffect(() => {
    if (fetcher.data?.downgraded) {
      shopify.toast.show("Downgraded to Free plan.");
      revalidate();
    }
  }, [fetcher.data, shopify, revalidate]);

  useEffect(() => {
    const activated = fetcher.data?.devActivated;
    if (activated) {
      const planName = PLANS[activated as PlanKey]?.name ?? activated;
      shopify.toast.show(`Switched to ${planName} plan.`);
      revalidate();
    }
  }, [fetcher.data, shopify, revalidate]);

  return (
    <s-page heading="COD Shield — Billing">
      {/* ── Usage bar ── */}
      <s-section heading="This Month's Usage">
        <div style={{ maxWidth: 500 }}>
          {!hasActiveSubscription && (
            <p
              style={{
                margin: "0 0 12px",
                fontSize: 13,
                color: "#7a5900",
                fontWeight: 700,
              }}
            >
              Choose Free or approve a paid Shopify subscription to continue. Status: {status}.
            </p>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            <span style={{ fontWeight: 700 }}>
              {hasActiveSubscription ? `${PLANS[currentPlan].name} Plan` : "No active plan"}
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
          {hasActiveSubscription && limit !== -1 && usagePct >= 80 && (
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
          {hasActiveSubscription && limit !== -1 && usagePct >= 100 && (
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

      {/* ── Declined billing banner ── */}
      {billingDeclined && (
        <s-section>
          <div
            style={{
              padding: "12px 16px",
              background: "#fff8f0",
              border: "1px solid #ffc58b",
              borderRadius: 8,
              color: "#7a4100",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Your subscription wasn't activated. You've been placed on the Free plan — you can upgrade
            any time below.
          </div>
        </s-section>
      )}

      {/* ── Managed Pricing banner ── */}
      {managedPricingBlocked && (
        <s-section>
          <div
            style={{
              padding: "16px 20px",
              background: "#fff8f0",
              border: "1px solid #ffc58b",
              borderRadius: 8,
              color: "#4a2900",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>
              ⚠️ Managed Pricing is active — Billing API is blocked
            </div>
            <p style={{ margin: "0 0 10px" }}>
              Your app has pricing plans set up in Shopify Partners (required for App Store submission),
              which blocks the in-app Billing API. This is expected during the review process.
            </p>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>For your dev store (testing):</div>
              Add <code style={{ background: "#fde8cc", padding: "1px 6px", borderRadius: 4 }}>DEV_BILLING_BYPASS_STORE=cod-shield.myshopify.com</code> to
              your Railway environment variables, then redeploy.
              Upgrade buttons will activate plans directly — safe because only your dev store is bypassed.
            </div>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>For the App Store reviewer:</div>
              They will select a plan during installation from the Partners dashboard.
              The app will automatically detect and display the correct plan.
            </div>
          </div>
        </s-section>
      )}

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
            const isCurrent = hasActiveSubscription && key === currentPlan;
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
                          ? hasActiveSubscription
                            ? "Downgrade to Free"
                            : "Start Free"
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

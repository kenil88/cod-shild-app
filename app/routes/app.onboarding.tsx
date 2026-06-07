import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useState } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOrCreateSubscription, activatePlan } from "../lib/billing.server";
import { PLANS, type PlanKey } from "../lib/plans";
import prisma from "../db.server";
import { sendWelcomeEmail } from "../lib/email.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [sub, rules] = await Promise.all([
    getOrCreateSubscription(shop),
    prisma.rule.findUnique({ where: { shopDomain: shop } }),
  ]);

  const plan = (sub.plan in PLANS ? sub.plan : "free") as PlanKey;

  return {
    plan,
    autoCancel: rules?.autoCancel ?? false,
  };
};

const SHOP_OWNER_QUERY = `#graphql
  query GetShopOwner {
    shop {
      name
      email
      contactEmail
      billingAddress {
        firstName
        lastName
      }
    }
  }
`;

const GET_PAYMENT_CUSTOMIZATIONS = `#graphql
  query GetPaymentCustomizations {
    paymentCustomizations(first: 25) {
      edges { node { id title } }
    }
  }
`;

const CREATE_PAYMENT_CUSTOMIZATION = `#graphql
  mutation CreatePaymentCustomization($input: PaymentCustomizationInput!) {
    paymentCustomizationCreate(paymentCustomization: $input) {
      paymentCustomization { id }
      userErrors { field message }
    }
  }
`;

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();

  const autoCancel = form.get("autoCancel") === "true";

  const existingMerchant = await prisma.merchant.findUnique({
    where: { shopDomain: shop },
    select: { onboardingCompleted: true },
  });
  const isFirstSetup = !existingMerchant || !existingMerchant.onboardingCompleted;

  await Promise.all([
    prisma.rule.upsert({
      where: { shopDomain: shop },
      create: { shopDomain: shop, autoCancel },
      update: { autoCancel },
    }),
    prisma.merchant.upsert({
      where: { shopDomain: shop },
      create: { shopDomain: shop, onboardingCompleted: true },
      update: { onboardingCompleted: true },
    }),
  ]);

  if (isFirstSetup) {
    try {
      const res = await admin.graphql(SHOP_OWNER_QUERY);
      const { data } = await res.json();
      const shopData = data?.shop;

      const email = shopData?.contactEmail || shopData?.email || "";
      const firstName = shopData?.billingAddress?.firstName || shopData?.name || "";
      const lastName = shopData?.billingAddress?.lastName || "";
      const fullName = `${firstName} ${lastName}`.trim();

      // Persist so uninstall webhook (no API access) can use it
      if (email || fullName) {
        await prisma.merchant.update({
          where: { shopDomain: shop },
          data: {
            ...(email ? { email } : {}),
            ...(fullName ? { shopName: fullName } : {}),
          },
        });
      }

      if (email) {
        await sendWelcomeEmail({ to: email, firstName, lastName });
      }
    } catch (err) {
      console.error("[COD King] Welcome email failed:", err);
    }

    // Activate the COD Hide Payment customization function (best-effort).
    // Skipped when the function hasn't been deployed yet (env var not set).
    const functionId = process.env.SHOPIFY_COD_HIDE_PAYMENT_ID;
    if (functionId) {
      try {
        // Idempotency: skip if a customization with this title already exists
        const existingRes = await admin.graphql(GET_PAYMENT_CUSTOMIZATIONS);
        const { data: existingData } = await existingRes.json();
        const alreadyExists = (existingData?.paymentCustomizations?.edges ?? []).some(
          (e: { node: { title: string } }) => e.node.title === "COD Hide Payment"
        );
        if (!alreadyExists) {
          await admin.graphql(CREATE_PAYMENT_CUSTOMIZATION, {
            variables: { input: { title: "COD Hide Payment", enabled: true, functionId } },
          });
        }
      } catch (err) {
        console.error("[COD Shield] Payment customization activation failed:", err);
      }
    }
  }

  // Activate free plan if the merchant hasn't paid for a higher plan yet.
  // Without this, subscription stays "pending" and order scanning is blocked.
  const sub = await getOrCreateSubscription(shop);
  if (sub.status !== "active") {
    await activatePlan(shop, "free");
  }

  throw redirect("/app");
};

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, labels }: { current: number; labels: string[] }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 40 }}>
      {labels.map((label, i) => {
        const num = i + 1;
        const done = num < current;
        const active = num === current;
        return (
          <div key={label} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  background: done || active ? "#008060" : "#e4e5e7",
                  color: done || active ? "#fff" : "#6d7175",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  fontWeight: 800,
                  transition: "all 0.25s",
                }}
              >
                {done ? "✓" : num}
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  color: active ? "#008060" : done ? "#3d4147" : "#8c9196",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </span>
            </div>
            {i < labels.length - 1 && (
              <div
                style={{
                  width: 60,
                  height: 2,
                  background: done ? "#008060" : "#e4e5e7",
                  margin: "0 8px",
                  marginBottom: 20,
                  transition: "background 0.25s",
                  flexShrink: 0,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────────

function Step1({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const features = [
    {
      icon: "🎯",
      title: "Score every COD order automatically",
      desc: "8 risk signals checked in real-time on every order — no manual work needed.",
    },
    {
      icon: "🏷️",
      title: "Auto-tag risky orders in Shopify",
      desc: "High-risk orders get tagged cod-high-risk so your ops team can act instantly.",
    },
    {
      icon: "❌",
      title: "Auto-cancel fraud orders",
      desc: "Block bad orders before they ship and save on courier + restocking costs.",
    },
    {
      icon: "📊",
      title: "Track RTO patterns over time",
      desc: "Learn which pincodes and customers return the most — and block them.",
    },
  ];

  return (
    <div style={{ maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
      <div style={{ fontSize: 64, marginBottom: 16, lineHeight: 1 }}>🛡️</div>
      <h1 style={{ fontSize: 26, fontWeight: 900, color: "#1a1a1a", margin: "0 0 10px" }}>
        Welcome to COD Shield
      </h1>
      <p style={{ fontSize: 15, color: "#6d7175", margin: "0 0 32px", lineHeight: 1.6 }}>
        Protect your store from fake COD orders — automatically detect, flag, and block
        high-risk orders before they ship.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 36, textAlign: "left" }}>
        {features.map((f) => (
          <div
            key={f.title}
            style={{
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
              padding: "14px 16px",
              borderRadius: 10,
              background: "#f4fff8",
              border: "1px solid #d3f5e5",
            }}
          >
            <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>{f.icon}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a", marginBottom: 2 }}>{f.title}</div>
              <div style={{ fontSize: 12, color: "#6d7175", lineHeight: 1.5 }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <button
          onClick={onNext}
          style={{
            padding: "13px 40px",
            borderRadius: 8,
            background: "#008060",
            color: "#fff",
            fontWeight: 800,
            fontSize: 15,
            border: "none",
            cursor: "pointer",
            letterSpacing: "0.2px",
          }}
        >
          Get Started →
        </button>
        <button
          onClick={onSkip}
          style={{ background: "none", border: "none", color: "#8c9196", fontSize: 13, cursor: "pointer" }}
        >
          Skip setup — go to dashboard
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Plan ─────────────────────────────────────────────────────────────

function Step2({ plan, onBack, onNext }: { plan: PlanKey; onBack: () => void; onNext: () => void }) {
  const [selected, setSelected] = useState<PlanKey>(plan);
  const planList = Object.entries(PLANS) as [PlanKey, typeof PLANS[PlanKey]][];
  const isPaid = selected !== "free";

  const handleContinue = () => {
    if (isPaid) {
      // Go to billing page to complete the upgrade, then return to finish setup
      window.location.href = "/app/billing";
    } else {
      onNext();
    }
  };

  return (
    <div style={{ maxWidth: 580, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <h2 style={{ fontSize: 22, fontWeight: 900, color: "#1a1a1a", margin: "0 0 8px" }}>
          Choose Your Plan
        </h2>
        <p style={{ fontSize: 14, color: "#6d7175", margin: 0 }}>
          Start free — upgrade anytime as your order volume grows.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 20,
        }}
      >
        {planList.map(([key, p]) => {
          const isSelected = key === selected;
          return (
            <div
              key={key}
              onClick={() => setSelected(key)}
              style={{
                padding: "16px 18px",
                borderRadius: 10,
                border: isSelected ? "2px solid #008060" : "1px solid #e4e5e7",
                background: isSelected ? "#f4fff8" : "#fff",
                position: "relative",
                cursor: "pointer",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {isSelected && (
                <span
                  style={{
                    position: "absolute",
                    top: -11,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "#008060",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 800,
                    padding: "2px 12px",
                    borderRadius: 20,
                    whiteSpace: "nowrap",
                  }}
                >
                  {key === plan ? "CURRENT PLAN" : "SELECTED"}
                </span>
              )}
              <div style={{ fontWeight: 800, fontSize: 14, color: "#1a1a1a", marginBottom: 2 }}>
                {p.name}
              </div>
              <div style={{ fontSize: 22, fontWeight: 900, color: isSelected ? "#008060" : "#1a1a1a", margin: "4px 0 2px" }}>
                {p.price === 0 ? "Free" : `$${p.price}`}
                {p.price > 0 && <span style={{ fontSize: 12, fontWeight: 500, color: "#6d7175" }}>/mo</span>}
              </div>
              <div style={{ fontSize: 12, color: "#6d7175" }}>
                {p.limit === -1 ? "Unlimited orders" : `${p.limit.toLocaleString()} orders/mo`}
              </div>
            </div>
          );
        })}
      </div>

      {isPaid && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            background: "#f0faf6",
            border: "1px solid #d3f5e5",
            fontSize: 13,
            color: "#1a4731",
            marginBottom: 20,
            textAlign: "center",
          }}
        >
          You'll complete the <strong>${PLANS[selected].price}/mo</strong> upgrade on the billing page,
          then return here to finish setup.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button
          onClick={onBack}
          style={{ padding: "10px 20px", borderRadius: 6, border: "1px solid #c9cccf", background: "transparent", color: "#3d4147", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
        >
          ← Back
        </button>
        <button
          onClick={handleContinue}
          style={{ padding: "10px 24px", borderRadius: 6, background: "#008060", color: "#fff", fontWeight: 700, fontSize: 14, border: "none", cursor: "pointer" }}
        >
          {isPaid ? `Upgrade to ${PLANS[selected].name} →` : `Continue with Free →`}
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Enable Actions ───────────────────────────────────────────────────

function Step3({
  plan,
  autoCancel,
  setAutoCancel,
  onBack,
  fetcher,
}: {
  plan: PlanKey;
  autoCancel: boolean;
  setAutoCancel: (v: boolean) => void;
  onBack: () => void;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const isSubmitting = fetcher.state !== "idle";
  const canAutoTag = plan !== "free";
  const canAutoCancel = plan === "growth" || plan === "scale";

  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <h2 style={{ fontSize: 22, fontWeight: 900, color: "#1a1a1a", margin: "0 0 8px" }}>
          Enable Automatic Protection
        </h2>
        <p style={{ fontSize: 14, color: "#6d7175", margin: 0 }}>
          COD Shield always scores your orders. These settings control what happens automatically.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 32 }}>
        {/* Auto-tagging */}
        <div
          style={{
            padding: "16px 18px",
            borderRadius: 10,
            background: canAutoTag ? "#f4fff8" : "#f6f6f7",
            border: `1px solid ${canAutoTag ? "#d3f5e5" : "#e4e5e7"}`,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 18 }}>🏷️</span>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>
                  Auto-tag risky orders in Shopify
                </span>
                {!canAutoTag && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#e4e5e7", color: "#6d7175" }}>
                    Starter+
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#6d7175", paddingLeft: 26 }}>
                {canAutoTag
                  ? "High-risk orders will be tagged cod-high-risk automatically."
                  : "Upgrade to Starter to enable auto-tagging in Shopify."}
              </div>
            </div>
            <div
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                background: canAutoTag ? "#008060" : "#c9cccf",
                flexShrink: 0,
                marginLeft: 14,
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: canAutoTag ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              />
            </div>
          </div>
        </div>

        {/* Auto-cancel */}
        <div
          style={{
            padding: "16px 18px",
            borderRadius: 10,
            background: canAutoCancel && autoCancel ? "#fff8f8" : "#f6f6f7",
            border: `1px solid ${canAutoCancel && autoCancel ? "#f5c0b8" : "#e4e5e7"}`,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 18 }}>❌</span>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>
                  Auto-cancel high-risk orders
                </span>
                {!canAutoCancel && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "#e4e5e7", color: "#6d7175" }}>
                    Growth+
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "#6d7175", paddingLeft: 26 }}>
                {canAutoCancel
                  ? "Orders scoring 75+ will be automatically cancelled with reason: FRAUD."
                  : "Upgrade to Growth to enable automatic cancellation."}
              </div>
            </div>
            <div
              onClick={() => canAutoCancel && setAutoCancel(!autoCancel)}
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                background: canAutoCancel && autoCancel ? "#d72c0d" : "#c9cccf",
                flexShrink: 0,
                marginLeft: 14,
                position: "relative",
                cursor: canAutoCancel ? "pointer" : "default",
                transition: "background 0.2s",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 3,
                  left: canAutoCancel && autoCancel ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              />
            </div>
          </div>
        </div>

        {/* Always-on info */}
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 8,
            background: "#f6f6f7",
            border: "1px solid #e4e5e7",
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <span style={{ fontSize: 16 }}>ℹ️</span>
          <div style={{ fontSize: 12, color: "#6d7175", lineHeight: 1.5 }}>
            <strong style={{ color: "#3d4147" }}>Always active on all plans:</strong> Every COD order
            is scored, risk signals are detected, and results appear in your dashboard.
            You can fine-tune signal weights in Settings anytime.
          </div>
        </div>
      </div>

      <fetcher.Form method="POST">
        <input type="hidden" name="autoCancel" value={String(canAutoCancel && autoCancel)} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button
            type="button"
            onClick={onBack}
            style={{ padding: "10px 20px", borderRadius: 6, border: "1px solid #c9cccf", background: "transparent", color: "#3d4147", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            ← Back
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: "12px 32px",
              borderRadius: 8,
              background: isSubmitting ? "#c9cccf" : "#008060",
              color: "#fff",
              fontWeight: 800,
              fontSize: 15,
              border: "none",
              cursor: isSubmitting ? "default" : "pointer",
              letterSpacing: "0.2px",
            }}
          >
            {isSubmitting ? "Setting up…" : "Complete Setup →"}
          </button>
        </div>
      </fetcher.Form>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { plan, autoCancel: savedAutoCancel } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [step, setStep] = useState(1);
  const [autoCancel, setAutoCancel] = useState(savedAutoCancel);

  const handleSkip = () => {
    fetcher.submit({ autoCancel: "false" }, { method: "POST" });
  };

  return (
    <s-page heading="COD Shield — Setup">
      <s-section>
        <StepIndicator
          current={step}
          labels={["Welcome", "Choose Plan", "Enable Actions"]}
        />

        {step === 1 && (
          <Step1 onNext={() => setStep(2)} onSkip={handleSkip} />
        )}
        {step === 2 && (
          <Step2 plan={plan} onBack={() => setStep(1)} onNext={() => setStep(3)} />
        )}
        {step === 3 && (
          <Step3
            plan={plan}
            autoCancel={autoCancel}
            setAutoCancel={setAutoCancel}
            onBack={() => setStep(2)}
            fetcher={fetcher}
          />
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

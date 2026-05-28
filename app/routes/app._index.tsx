import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getDashboardStats,
  getCustomerHistory,
  getPincodeStats,
  getIpStats,
  getMerchantRules,
  saveRiskResult,
  updatePincodeStats,
  ensureMerchant,
} from "../lib/db.server";
import { scoreOrder, type OrderInput, type SignalKey, levelColor } from "../lib/riskEngine";
import { incrementOrderCount, getOrCreateSubscription, activatePlan } from "../lib/billing.server";
import { scheduleWebhookJobDrain, buildRiskAssessmentVars } from "../lib/webhook-jobs.server";
import { PLANS, type PlanKey } from "../lib/plans";
import prisma from "../db.server";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const RECENT_ORDERS_QUERY = `#graphql
  query GetRecentOrders {
    orders(first: 20, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          legacyResourceId
          createdAt
          paymentGatewayNames
          totalPriceSet { shopMoney { amount } }
          clientIp
          lineItems(first: 50) { edges { node { quantity } } }
          customer {
            id
            legacyResourceId
            phone
            email
            numberOfOrders
          }
          shippingAddress {
            address1
            city
            zip
            provinceCode
            phone
          }
        }
      }
    }
  }
`;

const TAG_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const CANCEL_MUTATION = `#graphql
  mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!, $restock: Boolean!) {
    orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer, restock: $restock) {
      orderCancelUserErrors { field message }
    }
  }
`;

const RISK_ASSESSMENT_MUTATION = `#graphql
  mutation OrderRiskAssessmentCreate($orderRiskAssessmentInput: OrderRiskAssessmentCreateInput!) {
    orderRiskAssessmentCreate(orderRiskAssessmentInput: $orderRiskAssessmentInput) {
      orderRiskAssessment { riskLevel }
      userErrors { field message }
    }
  }
`;

const COD_KEYWORDS = ["cash on delivery", "cod", "pay on delivery", "manual"];
function isCOD(names: string[]) {
  return names.some((n) => COD_KEYWORDS.some((k) => n.toLowerCase().includes(k)));
}

// ─── Loader ───────────────────────────────────────────────────────────────────

const ORDER_FIELDS_SELECT = {
  id: true,
  orderNumber: true,
  shopifyOrderId: true,
  riskScore: true,
  riskLevel: true,
  action: true,
  signalsTriggered: true,
  isBlocked: true,
  rtoConfirmed: true,
  orderValue: true,
  createdAt: true,
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const shop = session.shop;

  const [initialStats, sub, merchant] = await Promise.all([
    getDashboardStats(shop),
    getOrCreateSubscription(shop),
    prisma.merchant.findUnique({ where: { shopDomain: shop } }),
  ]);

  // Fresh install with no orders → send to onboarding wizard
  if (!merchant || (!merchant.onboardingCompleted && initialStats.totalOrders === 0)) {
    throw redirect("/app/onboarding");
  }

  // Auto-heal: free plan subscriptions stuck in "pending" can't scan orders.
  // Activate them here so merchants who completed onboarding aren't blocked.
  let activeSub = sub;
  if (sub.status !== "active") {
    await activatePlan(shop, "free");
    activeSub = { ...sub, plan: "free", status: "active", ordersThisMonth: 0 };
  }

  const plan = (activeSub.plan in PLANS ? activeSub.plan : "free") as PlanKey;
  const limit = PLANS[plan].limit;

  // Auto-scan: pull last 20 Shopify orders and save any new COD orders.
  // This runs on every loader call (including the 30s poll) so orders appear
  // automatically even when webhook delivery is broken.
  try {
    const res = await admin.graphql(RECENT_ORDERS_QUERY);
    const { data } = await res.json();
    if (data?.orders) {
      const rawOrders = (data.orders.edges ?? []).map(
        (e: { node: unknown }) => e.node as Record<string, unknown>
      );
      const rules = await getMerchantRules(shop);

      for (const o of rawOrders) {
        const gatewayNames = (o.paymentGatewayNames as string[]) ?? [];
        if (!isCOD(gatewayNames)) continue;

        const gid = o.id as string;
        const dup = await prisma.codOrder.findFirst({
          where: { shopDomain: shop, shopifyOrderId: gid },
          select: { id: true },
        });
        if (dup) continue;

        const billing = await incrementOrderCount(shop);
        if (!billing.allowed) break;

        const lineItems = (
          (o.lineItems as { edges: { node: { quantity: number } }[] })?.edges ?? []
        ).map((e) => ({ quantity: e.node.quantity }));

        const order: OrderInput = {
          shopifyOrderId: gid,
          orderNumber: ((o.name as string) ?? "").replace("#", ""),
          paymentMethod: gatewayNames.join(", "),
          totalPrice: parseFloat(
            (o.totalPriceSet as { shopMoney: { amount: string } })?.shopMoney?.amount ?? "0"
          ),
          lineItems,
          createdAt: (o.createdAt as string) ?? new Date().toISOString(),
          ip: (o.clientIp as string) ?? null,
          customer: o.customer
            ? {
                id: String((o.customer as { legacyResourceId: string }).legacyResourceId),
                phone: (o.customer as { phone?: string | null }).phone ?? null,
                email: (o.customer as { email?: string | null }).email ?? null,
                ordersCount: Number(
                  (o.customer as { numberOfOrders?: number }).numberOfOrders ?? 0
                ),
              }
            : null,
          shippingAddress: o.shippingAddress
            ? {
                address1: (o.shippingAddress as { address1?: string }).address1 ?? null,
                city: (o.shippingAddress as { city?: string }).city ?? null,
                zip: (o.shippingAddress as { zip?: string }).zip ?? null,
                phone: (o.shippingAddress as { phone?: string | null }).phone ?? null,
              }
            : null,
        };

        const phone = order.customer?.phone ?? order.shippingAddress?.phone ?? null;
        const email = order.customer?.email ?? null;
        const pincode = order.shippingAddress?.zip ?? null;

        const [customerHistory, pincodeStats, ipStats] = await Promise.all([
          getCustomerHistory(shop, phone, email),
          getPincodeStats(shop, pincode),
          getIpStats(shop, order.ip, 60),
        ]);

        const result = scoreOrder(order, customerHistory, pincodeStats, ipStats, rules);

        await Promise.all([
          saveRiskResult(shop, order, result),
          updatePincodeStats(shop, order, false),
          ensureMerchant(shop),
        ]);

        // Submit risk assessment so "Order risk" panel shows our data
        await admin.graphql(RISK_ASSESSMENT_MUTATION, {
          variables: buildRiskAssessmentVars(gid, result.score, result.level, result.triggeredSignals),
        });
      }
    }
  } catch (scanErr) {
    console.error("[COD Shield] Auto-scan error in loader:", scanErr);
  }

  // Re-query after auto-scan so any newly saved orders are included
  const [stats, orders] = await Promise.all([
    getDashboardStats(shop),
    prisma.codOrder.findMany({
      where: { shopDomain: shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: ORDER_FIELDS_SELECT,
    }),
  ]);

  // Flush any webhook jobs that were queued but not yet processed
  scheduleWebhookJobDrain();

  const usagePct = limit === -1 ? 0 : Math.min(100, (activeSub.ordersThisMonth / limit) * 100);
  return { stats, orders, shop, plan, ordersThisMonth: activeSub.ordersThisMonth, limit, usagePct };
};

// ─── Action (Scan Recent Orders) ──────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;

    const res = await admin.graphql(RECENT_ORDERS_QUERY);
    const { data } = await res.json();

    if (!data?.orders) {
      return { scanned: 0, skipped: 0, error: "Order access not approved. Enable Protected Customer Data in the Shopify Partner Dashboard." };
    }

    const rawOrders = (data.orders.edges ?? []).map((e: { node: unknown }) => e.node as Record<string, unknown>);
    const rules = await getMerchantRules(shop);
    await ensureMerchant(shop);

    let scanned = 0;
    let skipped = 0;

    for (const o of rawOrders) {
      const gatewayNames = (o.paymentGatewayNames as string[]) ?? [];
      if (!isCOD(gatewayNames)) { skipped++; continue; }

      const gid = o.id as string;
      const orderNum = ((o.name as string) ?? "").replace("#", "");
      const existing = await prisma.codOrder.findFirst({
        where: { shopDomain: shop, shopifyOrderId: gid },
        select: { id: true, riskScore: true, riskLevel: true, signalsTriggered: true },
      });

      if (existing) {
        // Already scored — just (re-)submit the risk assessment to Shopify so it
        // shows up in the "Order risk" panel instead of "Analysis not available".
        const signals = (Array.isArray(existing.signalsTriggered) ? existing.signalsTriggered : []) as string[];
        await admin.graphql(RISK_ASSESSMENT_MUTATION, {
          variables: buildRiskAssessmentVars(gid, existing.riskScore, existing.riskLevel, signals),
        });
        skipped++;
        continue;
      }

      // New order — check billing limit before doing any work
      const billing = await incrementOrderCount(shop);
      if (!billing.allowed) {
        skipped++;
        break; // merchant is at their plan limit
      }

      const lineItems = ((o.lineItems as { edges: { node: { quantity: number } }[] })?.edges ?? []).map((e) => ({ quantity: e.node.quantity }));

      const order: OrderInput = {
        shopifyOrderId: gid,
        orderNumber: orderNum,
        paymentMethod: gatewayNames.join(", "),
        totalPrice: parseFloat((o.totalPriceSet as { shopMoney: { amount: string } })?.shopMoney?.amount ?? "0"),
        lineItems,
        createdAt: (o.createdAt as string) ?? new Date().toISOString(),
        ip: (o.clientIp as string) ?? null,
        customer: o.customer ? {
          id: String((o.customer as { legacyResourceId: string }).legacyResourceId),
          phone: (o.customer as { phone?: string | null }).phone ?? null,
          email: (o.customer as { email?: string | null }).email ?? null,
          ordersCount: Number((o.customer as { numberOfOrders?: number }).numberOfOrders ?? 0),
        } : null,
        shippingAddress: o.shippingAddress ? {
          address1: (o.shippingAddress as { address1?: string }).address1 ?? null,
          city: (o.shippingAddress as { city?: string }).city ?? null,
          zip: (o.shippingAddress as { zip?: string }).zip ?? null,
          phone: (o.shippingAddress as { phone?: string | null }).phone ?? null,
        } : null,
      };

      const phone = order.customer?.phone ?? order.shippingAddress?.phone ?? null;
      const email = order.customer?.email ?? null;
      const pincode = order.shippingAddress?.zip ?? null;

      const [customerHistory, pincodeStats, ipStats] = await Promise.all([
        getCustomerHistory(shop, phone, email),
        getPincodeStats(shop, pincode),
        getIpStats(shop, order.ip, 60),
      ]);

      const result = scoreOrder(order, customerHistory, pincodeStats, ipStats, rules);

      await Promise.all([
        saveRiskResult(shop, order, result),
        updatePincodeStats(shop, order, false),
      ]);

      // Submit risk assessment — shows up in Shopify "Order risk" panel
      await admin.graphql(RISK_ASSESSMENT_MUTATION, {
        variables: buildRiskAssessmentVars(gid, result.score, result.level, result.triggeredSignals),
      });

      // Auto-tag (Starter+ only)
      if (result.level !== "safe" && billing.plan !== "free") {
        const tag = result.level === "high" ? "cod-high-risk" : "cod-medium-risk";
        await admin.graphql(TAG_MUTATION, { variables: { id: gid, tags: [tag, "cod-shield"] } });
      }

      // Auto-cancel (Growth+ only, high-value orders excluded)
      const isGrowthPlus = billing.plan === "growth" || billing.plan === "scale";
      const isHighValue = order.totalPrice >= (rules.highValueThreshold ?? 5000);
      if (result.action === "cancel" && rules.autoCancel && isGrowthPlus && !isHighValue) {
        await admin.graphql(CANCEL_MUTATION, {
          variables: { orderId: gid, reason: "FRAUD", notifyCustomer: false, restock: true },
        });
      }

      scanned++;
    }

    return { scanned, skipped, error: null };
  } catch (err) {
    console.error("[COD Shield] Scan error:", err);
    const message = err instanceof Error ? err.message : "Unknown error occurred";
    return { scanned: 0, skipped: 0, error: `Scan failed: ${message}` };
  }
};

// ─── Signal labels ────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<SignalKey, string> = {
  new_customer: "New customer",
  high_rto_pincode: "High-RTO pincode",
  unusual_quantity: "Unusual qty",
  night_order: "Night order",
  incomplete_address: "Bad address",
  past_rto_history: "Past RTO",
  multiple_addresses: "Multi-address",
  order_velocity: "High velocity",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBar({ score, level }: { score: number; level: string }) {
  const color = levelColor(level as "safe" | "medium" | "high");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 130 }}>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#e4e5e7", overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, minWidth: 26, color }}>{score}</span>
    </div>
  );
}

function LevelBadge({ level }: { level: string }) {
  const cfg = {
    high:   { bg: "#ffd2cc", color: "#6d1a13", label: "High" },
    medium: { bg: "#fff3cd", color: "#7a5900", label: "Medium" },
    safe:   { bg: "#d3f5e5", color: "#0d4d2e", label: "Safe" },
  }[level] ?? { bg: "#e4e5e7", color: "#3d4147", label: level };

  return (
    <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

function SignalChips({ signals }: { signals: unknown }) {
  const keys = (Array.isArray(signals) ? signals : []) as SignalKey[];
  if (keys.length === 0) return <span style={{ color: "#8c9196", fontSize: 12 }}>None</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {keys.map((k) => (
        <span key={k} style={{ padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: "#f1f1f1", color: "#3d4147", whiteSpace: "nowrap" }}>
          {SIGNAL_LABELS[k] ?? k}
        </span>
      ))}
    </div>
  );
}

function MarkRTOButton({ orderId, rtoConfirmed }: { orderId: string; rtoConfirmed: boolean }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const [confirming, setConfirming] = useState(false);

  if (rtoConfirmed) {
    return <span style={{ fontSize: 12, fontWeight: 700, color: "#d72c0d" }}>RTO Confirmed</span>;
  }

  if (confirming) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#d72c0d", fontWeight: 600, whiteSpace: "nowrap" }}>
          Mark RTO?
        </span>
        <fetcher.Form method="POST" action="/app/mark-rto" style={{ display: "inline" }}>
          <input type="hidden" name="codOrderId" value={orderId} />
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: "3px 12px", borderRadius: 6, border: "none",
              background: "#d72c0d", color: "#fff", fontSize: 12,
              fontWeight: 700, cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? "…" : "Yes"}
          </button>
        </fetcher.Form>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          style={{
            padding: "3px 10px", borderRadius: 6, border: "1px solid #c9cccf",
            background: "transparent", color: "#3d4147", fontSize: 12, cursor: "pointer",
          }}
        >
          No
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      style={{
        padding: "4px 10px", borderRadius: 6, border: "1px solid #d72c0d",
        background: "transparent", color: "#d72c0d", fontSize: 12,
        fontWeight: 600, cursor: "pointer",
      }}
    >
      Mark RTO
    </button>
  );
}

// ─── Row background by level ──────────────────────────────────────────────────

function rowBg(level: string, rtoConfirmed: boolean) {
  if (rtoConfirmed) return "#fff0f0";
  if (level === "high")   return "#fff8f8";
  if (level === "medium") return "#fffef0";
  return "#f8fff9";
}

// ─── Dashboard page ───────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

export default function Dashboard() {
  const { stats, orders, shop, plan, ordersThisMonth, limit, usagePct } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const isScanning = fetcher.state !== "idle";
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-poll: re-fetch loader data every 30 s so new webhook-processed orders appear
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
        setLastUpdated(new Date());
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [revalidator]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.error) {
        shopify.toast.show(fetcher.data.error, { isError: true });
      } else {
        shopify.toast.show(`Scanned ${fetcher.data.scanned} orders, ${fetcher.data.skipped} skipped`);
      }
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="COD Shield — Risk Dashboard">
      <style>{PULSE_STYLE}</style>

      {/* ── Upgrade banners (must be inside s-section to render in Shopify iframe) ── */}
      {limit !== -1 && usagePct >= 100 && (
        <s-section>
          <UsageBanner type="hard" ordersThisMonth={ordersThisMonth} limit={limit} plan={plan} />
        </s-section>
      )}
      {limit !== -1 && usagePct >= 80 && usagePct < 100 && (
        <s-section>
          <UsageBanner type="soft" usagePct={Math.round(usagePct)} ordersThisMonth={ordersThisMonth} limit={limit} plan={plan} />
        </s-section>
      )}

      {/* Live indicator */}
      <div slot="primary-action" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#1a7a4a" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#1a7a4a", display: "inline-block", animation: "pulse 2s infinite" }} />
          Live · updated {lastUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        <s-button
          onClick={() => fetcher.submit({}, { method: "POST" })}
          {...(isScanning ? { loading: true } : {})}
        >
          {isScanning ? "Scanning..." : "Scan Recent Orders"}
        </s-button>
      </div>

      {/* ── Stat cards ── */}
      <s-section>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <StatCard
            label="Total Analyzed"
            value={stats.totalOrders}
            sub="COD orders scored"
            color="#3d4147"
            bg="#f6f6f7"
          />
          <StatCard
            label="Blocked Today"
            value={stats.blockedToday}
            sub="auto-cancelled"
            color="#d72c0d"
            bg="#fff8f8"
          />
          <StatCard
            label="Money Saved"
            value={`₹${stats.moneySaved.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}
            sub="from blocked orders"
            color="#1a7a4a"
            bg="#f4fff8"
          />
          <UsageCard
            plan={plan}
            ordersThisMonth={ordersThisMonth}
            limit={limit}
            usagePct={usagePct}
          />
        </div>
      </s-section>

      {/* ── Orders table ── */}
      <s-section heading="Analyzed Orders">
        {orders.length === 0 ? (
          <EmptyState onScan={() => fetcher.submit({}, { method: "POST" })} isScanning={isScanning} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["Order ↕", "Score", "Level", "Signals Triggered", "Date", ""].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const isExpanded = selectedOrderId === o.id;
                  const numericId = o.shopifyOrderId.replace(/.*\//, "");
                  return (
                    <Fragment key={o.id}>
                      <tr
                        onClick={() => setSelectedOrderId(isExpanded ? null : o.id)}
                        style={{
                          background: rowBg(o.riskLevel, o.rtoConfirmed),
                          cursor: "pointer",
                          borderBottom: isExpanded ? "none" : undefined,
                        }}
                      >
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 700, color: "#008060" }}>#{o.orderNumber}</div>
                          {o.isBlocked && (
                            <span style={{ fontSize: 11, color: "#d72c0d", fontWeight: 600 }}>BLOCKED</span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          <ScoreBar score={o.riskScore} level={o.riskLevel} />
                        </td>
                        <td style={tdStyle}>
                          <LevelBadge level={o.riskLevel} />
                        </td>
                        <td style={{ ...tdStyle, maxWidth: 280 }}>
                          <SignalChips signals={o.signalsTriggered} />
                        </td>
                        <td style={{ ...tdStyle, whiteSpace: "nowrap", color: "#6d7175" }}>
                          {new Date(o.createdAt).toLocaleDateString("en-IN", {
                            day: "2-digit", month: "short", year: "numeric",
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </td>
                        <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                          <MarkRTOButton orderId={o.id} rtoConfirmed={o.rtoConfirmed} />
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ background: rowBg(o.riskLevel, o.rtoConfirmed) }}>
                          <td colSpan={6} style={{ padding: "0 14px 16px" }}>
                            <OrderDetailPanel
                              order={o}
                              shop={shop}
                              numericId={numericId}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* ── Aside ── */}
      <s-section slot="aside" heading="Risk Levels">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <LegendRow color="#d72c0d" bg="#fff8f8" label="High" desc="Score ≥ 60 — cancel / block" />
          <LegendRow color="#b98900" bg="#fffef0" label="Medium" desc="Score 30–59 — review" />
          <LegendRow color="#1a7a4a" bg="#f8fff9" label="Safe" desc="Score 0–29 — approve" />
        </div>
      </s-section>

      <s-section slot="aside" heading="Signals (8)">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(Object.entries(SIGNAL_LABELS) as [SignalKey, string][]).map(([key, label]) => (
            <div key={key} style={{ fontSize: 12, display: "flex", justifyContent: "space-between" }}>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}

// ─── Helper components ────────────────────────────────────────────────────────

function UsageBanner({
  type, usagePct, ordersThisMonth, limit, plan,
}: {
  type: "soft" | "hard";
  usagePct?: number;
  ordersThisMonth: number;
  limit: number;
  plan: string;
}) {
  const isHard = type === "hard";
  return (
    <div
      style={{
        margin: "0 0 16px",
        padding: "14px 18px",
        borderRadius: 8,
        background: isHard ? "#fff0f0" : "#fffbf0",
        border: `1.5px solid ${isHard ? "#f5c0b8" : "#ffd79a"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 13, color: isHard ? "#d72c0d" : "#7a5900" }}>
          {isHard
            ? `Order limit reached — scoring paused (${ordersThisMonth}/${limit} used on ${plan} plan)`
            : `${usagePct}% of your ${limit}-order limit used this month`}
        </div>
        <div style={{ fontSize: 12, color: "#6d7175", marginTop: 3 }}>
          {isHard
            ? "New COD orders are not being scored. Upgrade or wait for the 30-day cycle to reset."
            : "At 100%, new orders won't be scored until your cycle resets. Upgrade now to avoid gaps."}
        </div>
      </div>
      <a
        href="/app/billing"
        style={{
          padding: "8px 18px",
          borderRadius: 6,
          background: isHard ? "#d72c0d" : "#b98900",
          color: "#fff",
          fontWeight: 700,
          fontSize: 13,
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        Upgrade Now
      </a>
    </div>
  );
}

function StatCard({
  label, value, sub, color, bg,
}: {
  label: string; value: number | string; sub: string; color: string; bg: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 160, padding: "18px 20px", borderRadius: 10, background: bg, border: `1px solid ${color}22` }}>
      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#8c9196", marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function UsageCard({ plan, ordersThisMonth, limit, usagePct }: {
  plan: string; ordersThisMonth: number; limit: number; usagePct: number;
}) {
  const isUnlimited = limit === -1;
  const barColor = usagePct >= 100 ? "#d72c0d" : usagePct >= 80 ? "#b98900" : "#008060";
  const bg = usagePct >= 100 ? "#fff8f8" : usagePct >= 80 ? "#fffbf0" : "#f6f6f7";
  const borderColor = usagePct >= 100 ? "#f5c0b8" : usagePct >= 80 ? "#ffd79a" : "#e4e5e7";

  return (
    <div style={{ flex: 1, minWidth: 160, padding: "18px 20px", borderRadius: 10, background: bg, border: `1px solid ${borderColor}` }}>
      <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
        Plan Usage
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: barColor, lineHeight: 1.2 }}>
        {ordersThisMonth.toLocaleString()}
        <span style={{ fontSize: 13, fontWeight: 500, color: "#6d7175" }}>
          {" "}/ {isUnlimited ? "∞" : limit.toLocaleString()}
        </span>
      </div>
      <div style={{ margin: "8px 0 4px", height: 6, borderRadius: 3, background: "#e4e5e7", overflow: "hidden" }}>
        <div style={{ width: `${isUnlimited ? 0 : Math.min(100, usagePct)}%`, height: "100%", background: barColor, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#8c9196" }}>
          {plan.charAt(0).toUpperCase() + plan.slice(1)} plan
          {!isUnlimited && ` · ${Math.round(usagePct)}% used`}
        </div>
        {!isUnlimited && usagePct >= 80 && (
          <a href="/app/billing" style={{ fontSize: 11, fontWeight: 700, color: barColor, textDecoration: "none" }}>
            Upgrade ↗
          </a>
        )}
      </div>
    </div>
  );
}

function LegendRow({ color, bg, label, desc }: { color: string; bg: string; label: string; desc: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 12, color: "#6d7175" }}>{desc}</span>
    </div>
  );
}

function EmptyState({ onScan, isScanning }: { onScan: () => void; isScanning: boolean }) {
  return (
    <div style={{ textAlign: "center", padding: "56px 24px", color: "#6d7175" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🛡️</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>No orders analyzed yet</div>
      <div style={{ fontSize: 14, marginBottom: 20 }}>Click below to scan your last 20 COD orders.</div>
      <button
        onClick={onScan}
        disabled={isScanning}
        style={{ padding: "10px 24px", borderRadius: 8, background: "#008060", color: "#fff", border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
      >
        {isScanning ? "Scanning..." : "Scan Recent Orders"}
      </button>
    </div>
  );
}

function OrderDetailPanel({
  order,
  shop,
  numericId,
}: {
  order: {
    orderNumber: string;
    riskScore: number;
    riskLevel: string;
    action: string;
    signalsTriggered: unknown;
    isBlocked: boolean;
    rtoConfirmed: boolean;
    orderValue: number;
    createdAt: string | Date;
  };
  shop: string;
  numericId: string;
}) {
  const signals = (Array.isArray(order.signalsTriggered) ? order.signalsTriggered : []) as SignalKey[];
  const adminUrl = `https://${shop}/admin/orders/${numericId}`;

  const actionColor =
    order.action === "cancel" ? "#d72c0d" : order.action === "review" ? "#b98900" : "#1a7a4a";
  const actionLabel =
    order.action === "cancel" ? "Cancel / Block" : order.action === "review" ? "Review" : "Approve";

  return (
    <div
      style={{
        borderTop: "1px solid #e4e5e7",
        paddingTop: 14,
        display: "flex",
        flexWrap: "wrap",
        gap: 24,
      }}
    >
      {/* Score breakdown */}
      <div style={{ minWidth: 180 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", marginBottom: 6 }}>
          Risk Analysis
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, color: levelColor(order.riskLevel as "safe" | "medium" | "high") }}>
          {order.riskScore}
          <span style={{ fontSize: 13, fontWeight: 500, color: "#6d7175" }}>/100</span>
        </div>
        <div style={{ marginTop: 4 }}>
          <LevelBadge level={order.riskLevel} />
        </div>
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <span style={{ fontWeight: 600, color: "#3d4147" }}>Recommended action: </span>
          <span style={{ fontWeight: 700, color: actionColor }}>{actionLabel}</span>
        </div>
        {order.orderValue > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: "#6d7175" }}>
            Order value: ₹{order.orderValue.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
          </div>
        )}
      </div>

      {/* Signals */}
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", marginBottom: 6 }}>
          Signals Triggered ({signals.length})
        </div>
        {signals.length === 0 ? (
          <div style={{ fontSize: 12, color: "#8c9196" }}>No risk signals detected — order looks safe.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {signals.map((k) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d72c0d", flexShrink: 0, display: "inline-block" }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: "#3d4147" }}>
                  {SIGNAL_LABELS[k] ?? k}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status & link */}
      <div style={{ minWidth: 140 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", marginBottom: 6 }}>
          Status
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {order.isBlocked && (
            <span style={{ fontSize: 12, fontWeight: 700, color: "#d72c0d" }}>Blocked / Cancelled</span>
          )}
          {order.rtoConfirmed && (
            <span style={{ fontSize: 12, fontWeight: 700, color: "#d72c0d" }}>RTO Confirmed</span>
          )}
          {!order.isBlocked && !order.rtoConfirmed && (
            <span style={{ fontSize: 12, color: "#1a7a4a", fontWeight: 600 }}>Active</span>
          )}
        </div>
        <a
          href={adminUrl}
          target="_top"
          style={{
            display: "inline-block",
            marginTop: 12,
            fontSize: 12,
            fontWeight: 600,
            color: "#008060",
            textDecoration: "none",
            border: "1px solid #008060",
            borderRadius: 6,
            padding: "4px 12px",
          }}
        >
          View in Shopify ↗
        </a>
      </div>
    </div>
  );
}

const PULSE_STYLE = `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`;

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "10px 14px", background: "#f6f6f7",
  borderBottom: "2px solid #e4e5e7", fontWeight: 700, color: "#3d4147", whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "11px 14px", borderBottom: "1px solid #f1f2f3", verticalAlign: "middle",
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

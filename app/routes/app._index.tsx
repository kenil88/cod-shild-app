import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect, useRef, useState } from "react";
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
import { incrementOrderCount } from "../lib/billing.server";
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

const COD_KEYWORDS = ["cash on delivery", "cod", "pay on delivery", "manual"];
function isCOD(names: string[]) {
  return names.some((n) => COD_KEYWORDS.some((k) => n.toLowerCase().includes(k)));
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [stats, orders] = await Promise.all([
    getDashboardStats(shop),
    prisma.codOrder.findMany({
      where: { shopDomain: shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
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
      },
    }),
  ]);

  return { stats, orders, shop };
};

// ─── Action (Scan Recent Orders) ──────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
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

    const orderNum = ((o.name as string) ?? "").replace("#", "");
    const existing = await prisma.codOrder.findFirst({ where: { shopDomain: shop, orderNumber: orderNum } });
    if (existing) { skipped++; continue; }

    const lineItems = ((o.lineItems as { edges: { node: { quantity: number } }[] })?.edges ?? []).map((e) => ({ quantity: e.node.quantity }));

    const order: OrderInput = {
      shopifyOrderId: o.id as string,
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

    // Check billing limit before scoring
    const billing = await incrementOrderCount(shop);
    if (!billing.allowed) {
      skipped++;
      break; // stop scanning — merchant is at their plan limit
    }

    const result = scoreOrder(order, customerHistory, pincodeStats, ipStats, rules);

    await Promise.all([
      saveRiskResult(shop, order, result),
      updatePincodeStats(shop, order, false),
    ]);

    // Auto-tag
    if (result.level !== "safe") {
      const tag = result.level === "high" ? "cod-high-risk" : "cod-medium-risk";
      await admin.graphql(TAG_MUTATION, { variables: { id: o.id as string, tags: [tag, "cod-shield"] } });
    }

    // Auto-cancel
    if (result.action === "cancel" && rules.autoCancel) {
      await admin.graphql(CANCEL_MUTATION, {
        variables: { orderId: o.id as string, reason: "FRAUD", notifyCustomer: false, restock: true },
      });
    }

    scanned++;
  }

  return { scanned, skipped, error: null };
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

  if (rtoConfirmed) {
    return <span style={{ fontSize: 12, fontWeight: 700, color: "#d72c0d" }}>RTO Confirmed</span>;
  }

  return (
    <fetcher.Form method="POST" action="/app/mark-rto">
      <input type="hidden" name="codOrderId" value={orderId} />
      <button
        type="submit"
        disabled={busy}
        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d72c0d", background: "transparent", color: "#d72c0d", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
      >
        {busy ? "..." : "Mark RTO"}
      </button>
    </fetcher.Form>
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
  const { stats, orders } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const isScanning = fetcher.state !== "idle";
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
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
                  {["Order", "Score", "Level", "Signals Triggered", "Date", ""].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} style={{ background: rowBg(o.riskLevel, o.rtoConfirmed) }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 700 }}>#{o.orderNumber}</div>
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
                    <td style={tdStyle}>
                      <MarkRTOButton orderId={o.id} rtoConfirmed={o.rtoConfirmed} />
                    </td>
                  </tr>
                ))}
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

const PULSE_STYLE = `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`;

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "10px 14px", background: "#f6f6f7",
  borderBottom: "2px solid #e4e5e7", fontWeight: 700, color: "#3d4147", whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "11px 14px", borderBottom: "1px solid #f1f2f3", verticalAlign: "middle",
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

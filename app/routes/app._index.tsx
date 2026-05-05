import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { scoreOrder, type OrderPayload } from "../risk.server";

const RECENT_ORDERS_QUERY = `#graphql
  query GetRecentOrders {
    orders(first: 20, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          legacyResourceId
          paymentGatewayNames
          totalPriceSet { shopMoney { amount } }
          clientIp
          customer {
            id
            legacyResourceId
            phone
            numberOfOrders
          }
          shippingAddress {
            address1
            city
            provinceCode
            phone
          }
        }
      }
    }
  }
`;

const TAG_ORDER_MUTATION = `#graphql
  mutation TagOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const CANCEL_ORDER_MUTATION = `#graphql
  mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $notifyCustomer: Boolean!, $restock: Boolean!) {
    orderCancel(orderId: $orderId, reason: $reason, notifyCustomer: $notifyCustomer, restock: $restock) {
      orderCancelUserErrors { field message }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const risks = await prisma.orderRisk.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const stats = {
    total: risks.length,
    high: risks.filter((r) => r.level === "high").length,
    medium: risks.filter((r) => r.level === "medium").length,
    low: risks.filter((r) => r.level === "low").length,
  };

  return { risks, stats };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Load settings for thresholds and auto-cancel flag
  const settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  const thresholds = {
    high: settings?.highThreshold ?? 70,
    med: settings?.medThreshold ?? 40,
  };
  const autoCancel = settings?.autoCancel ?? false;

  const res = await admin.graphql(RECENT_ORDERS_QUERY);
  const { data } = await res.json();

  if (!data?.orders) {
    return {
      scanned: 0,
      skipped: 0,
      error: "Order access not approved yet. Enable Protected Customer Data in your Shopify Partner Dashboard.",
    };
  }

  const orders = (data.orders.edges ?? []).map(
    (e: { node: unknown }) => e.node
  );

  let scanned = 0;
  let skipped = 0;

  for (const o of orders) {
    const orderNum = String(o.name?.replace("#", "") ?? o.legacyResourceId);

    const existing = await prisma.orderRisk.findFirst({
      where: { orderId: orderNum },
    });
    if (existing) { skipped++; continue; }

    const payload: OrderPayload = {
      id: Number(o.legacyResourceId),
      order_number: Number(orderNum),
      payment_gateway: (o.paymentGatewayNames ?? []).join(", "),
      total_price: o.totalPriceSet?.shopMoney?.amount ?? "0",
      browser_ip: o.clientIp ?? null,
      customer: o.customer
        ? {
            id: Number(o.customer.legacyResourceId),
            phone: o.customer.phone ?? null,
            orders_count: Number(o.customer.numberOfOrders ?? 0),
          }
        : null,
      shipping_address: o.shippingAddress
        ? {
            address1: o.shippingAddress.address1 ?? "",
            city: o.shippingAddress.city ?? "",
            province: o.shippingAddress.provinceCode ?? "",
            phone: o.shippingAddress.phone ?? null,
          }
        : null,
    };

    const { score, level, recommendation } = await scoreOrder(payload, thresholds);

    // Save risk record with Shopify GIDs
    await prisma.orderRisk.create({
      data: {
        orderId: orderNum,
        shopifyOrderGid: o.id ?? null,
        shopifyCustomerGid: o.customer?.id ?? null,
        score,
        level,
        recommendation,
      },
    });

    // Upsert customer
    if (o.customer?.legacyResourceId) {
      await prisma.customer.upsert({
        where: { id: String(o.customer.legacyResourceId) },
        create: {
          id: String(o.customer.legacyResourceId),
          phone: o.customer.phone ?? null,
          pastRTO: false,
        },
        update: { phone: o.customer.phone ?? undefined },
      });
    }

    if (o.id) {
      // Auto-tag high/medium risk orders
      if (level !== "low") {
        const tag = level === "high" ? "cod-high-risk" : "cod-medium-risk";
        await admin.graphql(TAG_ORDER_MUTATION, {
          variables: { id: o.id, tags: [tag, "cod-shield"] },
        });
      }

      // Auto-cancel high risk orders if enabled
      if (level === "high" && autoCancel) {
        await admin.graphql(CANCEL_ORDER_MUTATION, {
          variables: {
            orderId: o.id,
            reason: "FRAUD",
            notifyCustomer: false,
            restock: true,
          },
        });
      }
    }

    scanned++;
  }

  return { scanned, skipped, error: null };
};

function RiskBadge({ level }: { level: string }) {
  const tone =
    level === "high" ? "critical" : level === "medium" ? "warning" : "success";
  return (
    <s-badge tone={tone}>
      {level.charAt(0).toUpperCase() + level.slice(1)}
    </s-badge>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const color = score >= 70 ? "#d72c0d" : score >= 40 ? "#b98900" : "#1a7a4a";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: "#e4e5e7",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: 4,
          }}
        />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 28, color }}>
        {score}
      </span>
    </div>
  );
}

function MarkRTOButton({
  riskId,
  shopifyOrderGid,
  shopifyCustomerGid,
  rtoConfirmed,
}: {
  riskId: string;
  shopifyOrderGid: string | null;
  shopifyCustomerGid: string | null;
  rtoConfirmed: boolean;
}) {
  const fetcher = useFetcher();
  const isLoading = fetcher.state !== "idle";

  if (rtoConfirmed) {
    return <s-badge tone="critical">RTO Confirmed</s-badge>;
  }

  return (
    <fetcher.Form method="POST" action="/app/mark-rto">
      <input type="hidden" name="riskId" value={riskId} />
      <input type="hidden" name="shopifyOrderGid" value={shopifyOrderGid ?? ""} />
      <input type="hidden" name="shopifyCustomerGid" value={shopifyCustomerGid ?? ""} />
      <s-button
        tone="critical"
        variant="tertiary"
        {...(isLoading ? { loading: true } : {})}
        onClick={(e: React.MouseEvent) => {
          (e.target as HTMLElement).closest("form")?.requestSubmit();
        }}
      >
        Mark RTO
      </s-button>
    </fetcher.Form>
  );
}

export default function Dashboard() {
  const { risks, stats } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isScanning =
    fetcher.state === "submitting" || fetcher.state === "loading";

  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      if (fetcher.data.error) {
        shopify.toast.show(fetcher.data.error, { isError: true });
      } else {
        shopify.toast.show(
          `Scanned ${fetcher.data.scanned} new orders, ${fetcher.data.skipped} already scored`
        );
      }
    }
  }, [fetcher.data, fetcher.state, shopify]);

  return (
    <s-page heading="COD Shield — Risk Dashboard">
      <s-button
        slot="primary-action"
        onClick={() => fetcher.submit({}, { method: "POST" })}
        {...(isScanning ? { loading: true } : {})}
      >
        {isScanning ? "Scanning..." : "Scan Recent Orders"}
      </s-button>

      {/* Summary stat cards */}
      <s-section>
        <s-stack direction="inline" gap="base">
          <StatCard label="Total Analyzed" value={stats.total} color="#616161" />
          <StatCard label="High Risk" value={stats.high} color="#d72c0d" />
          <StatCard label="Medium Risk" value={stats.medium} color="#b98900" />
          <StatCard label="Low Risk" value={stats.low} color="#1a7a4a" />
        </s-stack>
      </s-section>

      {/* Orders table */}
      <s-section heading="Analyzed Orders">
        {risks.length === 0 ? (
          <EmptyState
            onScan={() => fetcher.submit({}, { method: "POST" })}
            isScanning={isScanning}
          />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {[
                    "Order",
                    "Risk Score",
                    "Risk Level",
                    "Recommendation",
                    "Analyzed At",
                    "Action",
                  ].map((h) => (
                    <th key={h} style={thStyle}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {risks.map((r, i) => (
                  <tr
                    key={r.id}
                    style={{
                      background: r.rtoConfirmed
                        ? "#fff4f4"
                        : i % 2 === 0
                          ? "#fff"
                          : "#f9fafb",
                    }}
                  >
                    <td style={tdStyle}>
                      <s-text fontWeight="semibold">#{r.orderId}</s-text>
                    </td>
                    <td style={{ ...tdStyle, minWidth: 140 }}>
                      <ScoreBar score={r.score} />
                    </td>
                    <td style={tdStyle}>
                      <RiskBadge level={r.level} />
                    </td>
                    <td style={tdStyle}>
                      <s-text>{r.recommendation}</s-text>
                    </td>
                    <td style={tdStyle}>
                      <s-text tone="subdued">
                        {new Date(r.createdAt).toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </s-text>
                    </td>
                    <td style={tdStyle}>
                      <MarkRTOButton
                        riskId={r.id}
                        shopifyOrderGid={r.shopifyOrderGid}
                        shopifyCustomerGid={r.shopifyCustomerGid}
                        rtoConfirmed={r.rtoConfirmed}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* Aside */}
      <s-section slot="aside" heading="Risk Levels">
        <s-stack direction="block" gap="tight">
          <s-paragraph>
            <s-badge tone="critical">High</s-badge>
            <s-text> Score ≥ 70 — Block or review COD</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-badge tone="warning">Medium</s-badge>
            <s-text> Score 40–69 — Manual review</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-badge tone="success">Low</s-badge>
            <s-text> Score &lt; 40 — Allow COD</s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="tight">
          <s-paragraph>
            <s-text>1. Click "Scan Recent Orders" to analyze your last 20 orders</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>2. High/medium risk orders are auto-tagged in Shopify</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>3. Click "Mark RTO" when a returned order is confirmed — future orders from that customer score higher</s-text>
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 140,
        padding: "16px 20px",
        borderRadius: 8,
        border: "1px solid #e4e5e7",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ fontSize: 13, color: "#6d7175", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function EmptyState({
  onScan,
  isScanning,
}: {
  onScan: () => void;
  isScanning: boolean;
}) {
  return (
    <div style={{ textAlign: "center", padding: "48px 24px", color: "#6d7175" }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🛡️</div>
      <s-heading>No orders analyzed yet</s-heading>
      <s-paragraph>
        Click the button below to scan your most recent 20 orders.
      </s-paragraph>
      <div style={{ marginTop: 16 }}>
        <s-button onClick={onScan} {...(isScanning ? { loading: true } : {})}>
          {isScanning ? "Scanning..." : "Scan Recent Orders"}
        </s-button>
      </div>
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  background: "#f6f6f7",
  borderBottom: "2px solid #e4e5e7",
  fontWeight: 600,
  color: "#3d4147",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid #e4e5e7",
  verticalAlign: "middle",
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getMerchantRules } from "../lib/db.server";
import prisma from "../db.server";
import type { SignalKey } from "../lib/riskEngine";

// ─── Signal definitions ───────────────────────────────────────────────────────

const SIGNALS: {
  key: SignalKey;
  label: string;
  defaultWeight: number;
  desc: string;
  triggerCondition: string;
}[] = [
  {
    key: "past_rto_history",
    label: "Past RTO History",
    defaultWeight: 25,
    desc: "Highest-weight signal. Flags repeat offenders.",
    triggerCondition: "Customer has ≥1 confirmed RTO on record",
  },
  {
    key: "high_rto_pincode",
    label: "High-RTO Pincode",
    defaultWeight: 20,
    desc: "Pincode-level intelligence built over time.",
    triggerCondition: "Delivery pincode has ≥30% RTO rate (min 5 orders of data)",
  },
  {
    key: "order_velocity",
    label: "Order Velocity",
    defaultWeight: 18,
    desc: "Detects bulk-fraud and bot-like ordering patterns.",
    triggerCondition: "≥3 orders from same IP in 60 min, or ≥2 from same customer in 24h",
  },
  {
    key: "new_customer",
    label: "New Customer",
    defaultWeight: 12,
    desc: "No order history to assess trust level.",
    triggerCondition: "Guest checkout or ≤1 previous order",
  },
  {
    key: "multiple_addresses",
    label: "Multiple Addresses",
    defaultWeight: 10,
    desc: "Frequent address changes suggest re-shipping abuse.",
    triggerCondition: "Customer used >3 distinct delivery addresses",
  },
  {
    key: "unusual_quantity",
    label: "Unusual Quantity",
    defaultWeight: 8,
    desc: "Large quantities on COD orders rarely complete.",
    triggerCondition: "Single item qty >5 or total items across order >15",
  },
  {
    key: "incomplete_address",
    label: "Incomplete Address",
    defaultWeight: 4,
    desc: "Undeliverable address = guaranteed RTO.",
    triggerCondition: "Missing or invalid street / city / 6-digit pincode",
  },
  {
    key: "night_order",
    label: "Night Order",
    defaultWeight: 3,
    desc: "Low-weight signal, used as a tie-breaker.",
    triggerCondition: "Order placed between 11 pm – 4 am IST",
  },
];

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [rules, blockedPhones, blockedAddresses] = await Promise.all([
    getMerchantRules(shop),
    prisma.address.findMany({
      where: { NOT: { phone: "" } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.address.findMany({
      where: { phone: "", NOT: { address: "" } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { rules, blockedPhones, blockedAddresses, shop };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "save-rules": {
      const weightKey = (k: SignalKey) => `${k}Weight`;
      const toggleKey = (k: SignalKey) => `${k}Toggle`;

      const data = {
        shopDomain: shop,
        autoCancel: form.get("autoCancel") === "true",
        autoCancelThreshold: clamp(Number(form.get("autoCancelThreshold")) || 75, 1, 100),
        // toggles
        newCustomer: form.get(toggleKey("new_customer")) === "true",
        highRtoPincode: form.get(toggleKey("high_rto_pincode")) === "true",
        unusualQuantity: form.get(toggleKey("unusual_quantity")) === "true",
        nightOrder: form.get(toggleKey("night_order")) === "true",
        incompleteAddress: form.get(toggleKey("incomplete_address")) === "true",
        pastRtoHistory: form.get(toggleKey("past_rto_history")) === "true",
        multipleAddresses: form.get(toggleKey("multiple_addresses")) === "true",
        orderVelocity: form.get(toggleKey("order_velocity")) === "true",
        // weights
        newCustomerWeight: clamp(Number(form.get(weightKey("new_customer"))) || 12, 1, 100),
        highRtoPincodeWeight: clamp(Number(form.get(weightKey("high_rto_pincode"))) || 20, 1, 100),
        unusualQuantityWeight: clamp(Number(form.get(weightKey("unusual_quantity"))) || 8, 1, 100),
        nightOrderWeight: clamp(Number(form.get(weightKey("night_order"))) || 3, 1, 100),
        incompleteAddressWeight: clamp(Number(form.get(weightKey("incomplete_address"))) || 4, 1, 100),
        pastRtoHistoryWeight: clamp(Number(form.get(weightKey("past_rto_history"))) || 25, 1, 100),
        multipleAddressesWeight: clamp(Number(form.get(weightKey("multiple_addresses"))) || 10, 1, 100),
        orderVelocityWeight: clamp(Number(form.get(weightKey("order_velocity"))) || 18, 1, 100),
      };

      await prisma.rule.upsert({
        where: { shopDomain: shop },
        create: data,
        update: data,
      });

      return { ok: true, message: "Settings saved" };
    }

    case "add-phone": {
      const phone = String(form.get("phone") ?? "").replace(/\D/g, "").slice(-10);
      if (phone.length >= 10) await prisma.address.create({ data: { phone, address: "" } });
      return { ok: true };
    }

    case "add-address": {
      const address = String(form.get("address") ?? "").trim().toLowerCase();
      if (address) await prisma.address.create({ data: { phone: "", address } });
      return { ok: true };
    }

    case "remove-entry": {
      const id = String(form.get("id") ?? "");
      if (id) await prisma.address.delete({ where: { id } });
      return { ok: true };
    }

    default:
      return { ok: false };
  }
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toggle({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <>
      <input type="hidden" name={name} value={String(checked)} />
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 44,
          height: 24,
          borderRadius: 12,
          background: checked ? "#008060" : "#c9cccf",
          position: "relative",
          cursor: "pointer",
          flexShrink: 0,
          transition: "background 0.2s",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 23 : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </div>
    </>
  );
}

function WeightBadge({ weight, enabled }: { weight: number; enabled: boolean }) {
  const color = !enabled ? "#c9cccf" : weight >= 20 ? "#d72c0d" : weight >= 10 ? "#b98900" : "#1a7a4a";
  return (
    <div style={{ textAlign: "center", minWidth: 36 }}>
      <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1 }}>{weight}</div>
      <div style={{ fontSize: 9, color: "#8c9196", letterSpacing: "0.3px" }}>pts</div>
    </div>
  );
}

function RemoveBtn({ id }: { id: string }) {
  const f = useFetcher();
  return (
    <f.Form method="POST">
      <input type="hidden" name="intent" value="remove-entry" />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #d72c0d", background: "transparent", color: "#d72c0d", fontSize: 12, cursor: "pointer" }}
      >
        Remove
      </button>
    </f.Form>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { rules, blockedPhones, blockedAddresses } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const saving = fetcher.state !== "idle";

  // Local state for controlled form fields
  const [toggles, setToggles] = useState<Record<SignalKey, boolean>>({
    new_customer: rules.newCustomer,
    high_rto_pincode: rules.highRtoPincode,
    unusual_quantity: rules.unusualQuantity,
    night_order: rules.nightOrder,
    incomplete_address: rules.incompleteAddress,
    past_rto_history: rules.pastRtoHistory,
    multiple_addresses: rules.multipleAddresses,
    order_velocity: rules.orderVelocity,
  });

  const [weights, setWeights] = useState<Record<SignalKey, number>>({
    new_customer: rules.newCustomerWeight,
    high_rto_pincode: rules.highRtoPincodeWeight,
    unusual_quantity: rules.unusualQuantityWeight,
    night_order: rules.nightOrderWeight,
    incomplete_address: rules.incompleteAddressWeight,
    past_rto_history: rules.pastRtoHistoryWeight,
    multiple_addresses: rules.multipleAddressesWeight,
    order_velocity: rules.orderVelocityWeight,
  });

  const [threshold, setThreshold] = useState(rules.autoCancelThreshold ?? 75);
  const [autoCancel, setAutoCancel] = useState(rules.autoCancel ?? false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && (fetcher.data as { message?: string }).message) {
      shopify.toast.show((fetcher.data as { message: string }).message);
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const totalScore = SIGNALS.reduce(
    (sum, s) => sum + (toggles[s.key] ? (weights[s.key] ?? s.defaultWeight) : 0),
    0
  );

  return (
    <s-page heading="COD Shield — Settings">

      {/* ── Signal Configuration ── */}
      <fetcher.Form method="POST">
        <input type="hidden" name="intent" value="save-rules" />
        <input type="hidden" name="autoCancel" value={String(autoCancel)} />
        <input type="hidden" name="autoCancelThreshold" value={String(threshold)} />

        <s-section heading="Signal Configuration">
          <div style={{ marginBottom: 12 }}>
            <s-paragraph>
              <s-text>
                Enable or disable each signal and adjust its weight.
                The score for a flagged order is the sum of weights of all triggered signals.
                Active signals currently sum to{" "}
                <strong style={{ color: totalScore > 100 ? "#d72c0d" : "#008060" }}>
                  {totalScore} pts
                </strong>
                {totalScore > 100 && " (scores are capped at 100)"}
                .
              </s-text>
            </s-paragraph>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f6f6f7" }}>
                <th style={{ ...th, width: 48 }}>On</th>
                <th style={th}>Signal</th>
                <th style={{ ...th, width: 90 }}>Weight</th>
                <th style={th}>Triggers when</th>
              </tr>
            </thead>
            <tbody>
              {SIGNALS.map((sig, i) => {
                const enabled = toggles[sig.key];
                return (
                  <tr
                    key={sig.key}
                    style={{ background: enabled ? (i % 2 === 0 ? "#fff" : "#fafafa") : "#f6f6f7", opacity: enabled ? 1 : 0.55 }}
                  >
                    <td style={{ ...td, textAlign: "center" }}>
                      <Toggle
                        name={`${sig.key}Toggle`}
                        checked={enabled}
                        onChange={(v) => setToggles((p) => ({ ...p, [sig.key]: v }))}
                      />
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{sig.label}</div>
                      <div style={{ fontSize: 11, color: "#6d7175", marginTop: 2 }}>{sig.desc}</div>
                    </td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <input type="hidden" name={`${sig.key}Weight`} value={weights[sig.key] ?? sig.defaultWeight} />
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                        <WeightBadge weight={weights[sig.key] ?? sig.defaultWeight} enabled={enabled} />
                        <input
                          type="range"
                          min={1}
                          max={50}
                          value={weights[sig.key] ?? sig.defaultWeight}
                          disabled={!enabled}
                          onChange={(e) =>
                            setWeights((p) => ({ ...p, [sig.key]: Number(e.target.value) }))
                          }
                          style={{ width: 70, accentColor: "#008060" }}
                        />
                      </div>
                    </td>
                    <td style={{ ...td, fontSize: 12, color: "#3d4147" }}>
                      {sig.triggerCondition}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </s-section>

        {/* ── Auto-Cancel Threshold ── */}
        <s-section heading="Auto-Cancel Threshold">
          <s-paragraph>
            <s-text>
              Orders scoring at or above this threshold will be automatically cancelled
              when auto-cancel is enabled. Currently set to{" "}
              <strong style={{ color: "#d72c0d" }}>{threshold}</strong>.
            </s-text>
          </s-paragraph>

          <div style={{ margin: "20px 0 8px" }}>
            {/* Gradient track label */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6d7175", marginBottom: 4 }}>
              <span>0 — Safe</span>
              <span>30 — Medium</span>
              <span>60 — High</span>
              <span>100</span>
            </div>
            {/* Coloured track */}
            <div style={{ position: "relative", height: 8, borderRadius: 4, background: "linear-gradient(to right, #1a7a4a 0%, #1a7a4a 30%, #b98900 30%, #b98900 60%, #d72c0d 60%)", marginBottom: 8 }}>
              <div
                style={{
                  position: "absolute",
                  top: -6,
                  left: `${threshold}%`,
                  transform: "translateX(-50%)",
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  border: "3px solid #d72c0d",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
                  pointerEvents: "none",
                }}
              />
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#d72c0d" }}
            />
          </div>

          {/* Auto-cancel toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16, padding: "14px 16px", borderRadius: 8, background: autoCancel ? "#fff8f8" : "#f6f6f7", border: `1px solid ${autoCancel ? "#f5c0b8" : "#e4e5e7"}` }}>
            <Toggle name="_autoCancelIgnored" checked={autoCancel} onChange={setAutoCancel} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: autoCancel ? "#d72c0d" : "#3d4147" }}>
                Auto-cancel high-risk COD orders
              </div>
              <div style={{ fontSize: 12, color: "#6d7175" }}>
                {autoCancel
                  ? `Orders scoring ≥ ${threshold} will be automatically cancelled with reason FRAUD.`
                  : "Orders will be tagged and flagged but not cancelled automatically."}
              </div>
            </div>
            {autoCancel && (
              <span style={{ marginLeft: "auto", padding: "2px 10px", borderRadius: 20, background: "#ffd2cc", color: "#6d1a13", fontSize: 12, fontWeight: 700 }}>
                ACTIVE
              </span>
            )}
          </div>
        </s-section>

        {/* Save button */}
        <div style={{ padding: "0 0 24px" }}>
          <s-button
            variant="primary"
            {...(saving ? { loading: true } : {})}
            onClick={(e: Event) => (e.target as HTMLElement).closest("form")?.requestSubmit()}
          >
            {saving ? "Saving..." : "Save Settings"}
          </s-button>
        </div>
      </fetcher.Form>

      {/* ── Blocked Phone Numbers ── */}
      <s-section heading="Blocked Phone Numbers">
        <s-paragraph>
          <s-text>Orders from these phones score +20 regardless of other signals.</s-text>
        </s-paragraph>
        <fetcher.Form method="POST" style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="add-phone" />
          <div>
            <div style={labelStyle}>Phone (10 digits)</div>
            <input type="tel" name="phone" placeholder="9876543210" style={inputStyle} required />
          </div>
          <s-button onClick={(e: Event) => (e.target as HTMLElement).closest("form")?.requestSubmit()}>Add</s-button>
        </fetcher.Form>
        <BlocklistTable rows={blockedPhones} col="phone" />
      </s-section>

      {/* ── Blocked Addresses ── */}
      <s-section heading="Blocked Delivery Addresses">
        <s-paragraph>
          <s-text>Orders to these addresses score +30. Format: address1|city|state</s-text>
        </s-paragraph>
        <fetcher.Form method="POST" style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="add-address" />
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>Address</div>
            <input type="text" name="address" placeholder="123 main st|mumbai|mh" style={{ ...inputStyle, width: "100%" }} required />
          </div>
          <s-button onClick={(e: Event) => (e.target as HTMLElement).closest("form")?.requestSubmit()}>Add</s-button>
        </fetcher.Form>
        <BlocklistTable rows={blockedAddresses} col="address" />
      </s-section>

      {/* ── Aside ── */}
      <s-section slot="aside" heading="Scoring guide">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {SIGNALS.map((s) => (
            <div key={s.key} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: toggles[s.key] ? "#3d4147" : "#8c9196" }}>{s.label}</span>
              <span style={{ fontWeight: 700, color: toggles[s.key] ? "#3d4147" : "#c9cccf" }}>
                {toggles[s.key] ? weights[s.key] : 0} pts
              </span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #e4e5e7", paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ fontWeight: 700 }}>Max possible</span>
            <span style={{ fontWeight: 700, color: totalScore > 100 ? "#d72c0d" : "#3d4147" }}>
              {totalScore} pts {totalScore > 100 ? "(capped at 100)" : ""}
            </span>
          </div>
        </div>
      </s-section>

      <s-section slot="aside" heading="Risk levels">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <div><span style={pill("#d72c0d", "#fff8f8")}>High</span> ≥ 60 pts</div>
          <div><span style={pill("#b98900", "#fffef0")}>Medium</span> 30–59 pts</div>
          <div><span style={pill("#1a7a4a", "#f4fff8")}>Safe</span> 0–29 pts</div>
          <div style={{ marginTop: 8, color: "#6d7175" }}>
            Auto-cancel triggers at <strong>{threshold} pts</strong>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

function BlocklistTable({
  rows,
  col,
}: {
  rows: { id: string; phone: string; address: string; createdAt: Date }[];
  col: "phone" | "address";
}) {
  if (rows.length === 0)
    return <p style={{ color: "#8c9196", fontSize: 13 }}>None added yet.</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 4 }}>
      <thead>
        <tr style={{ background: "#f6f6f7" }}>
          <th style={th}>{col === "phone" ? "Phone" : "Address"}</th>
          <th style={{ ...th, width: 110 }}>Added</th>
          <th style={{ ...th, width: 80 }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: "1px solid #f1f2f3" }}>
            <td style={td}>{col === "phone" ? r.phone : r.address}</td>
            <td style={{ ...td, color: "#6d7175" }}>{new Date(r.createdAt).toLocaleDateString()}</td>
            <td style={td}><RemoveBtn id={r.id} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: "left", padding: "9px 12px", fontWeight: 700,
  color: "#3d4147", borderBottom: "2px solid #e4e5e7", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "11px 12px", borderBottom: "1px solid #f1f2f3", verticalAlign: "middle",
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "#6d7175", marginBottom: 4 };
const inputStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 6, border: "1px solid #c9cccf", fontSize: 14, outline: "none",
};
function pill(color: string, bg: string): React.CSSProperties {
  return { padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 700, background: bg, color, marginRight: 6 };
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

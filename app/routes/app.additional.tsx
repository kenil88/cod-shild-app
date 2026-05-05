import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [settings, blockedPhones, blockedAddresses] = await Promise.all([
    prisma.appSettings.findUnique({ where: { id: "default" } }),
    prisma.address.findMany({ where: { NOT: { phone: "" } }, orderBy: { createdAt: "desc" } }),
    prisma.address.findMany({ where: { NOT: { address: "" }, phone: "" }, orderBy: { createdAt: "desc" } }),
  ]);

  return {
    settings: settings ?? { highThreshold: 70, medThreshold: 40, autoCancel: false },
    blockedPhones,
    blockedAddresses,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "save-thresholds": {
      const high = Math.min(100, Math.max(1, Number(form.get("highThreshold")) || 70));
      const med = Math.min(high - 1, Math.max(1, Number(form.get("medThreshold")) || 40));
      const autoCancel = form.get("autoCancel") === "true";
      await prisma.appSettings.upsert({
        where: { id: "default" },
        create: { id: "default", highThreshold: high, medThreshold: med, autoCancel },
        update: { highThreshold: high, medThreshold: med, autoCancel },
      });
      return { ok: true, message: "Settings saved" };
    }
    case "add-phone": {
      const phone = String(form.get("phone") ?? "").replace(/\D/g, "").slice(-10);
      if (phone.length >= 10) {
        await prisma.address.create({ data: { phone, address: "" } });
      }
      return { ok: true };
    }
    case "add-address": {
      const address = String(form.get("address") ?? "").trim().toLowerCase();
      if (address) {
        await prisma.address.create({ data: { phone: "", address } });
      }
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

export default function SettingsPage() {
  const { settings, blockedPhones, blockedAddresses } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const { revalidate } = useRevalidator();

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.state === "idle" && fetcher.data.message) {
      shopify.toast.show(fetcher.data.message);
      revalidate();
    } else if (fetcher.data?.ok && fetcher.state === "idle") {
      revalidate();
    }
  }, [fetcher.data, fetcher.state, shopify, revalidate]);

  const isSaving = fetcher.state !== "idle";

  return (
    <s-page heading="COD Shield — Settings">

      {/* Risk Thresholds */}
      <s-section heading="Risk Score Thresholds">
        <fetcher.Form method="POST">
          <input type="hidden" name="intent" value="save-thresholds" />
          <input
            type="hidden"
            name="autoCancel"
            value={String(settings.autoCancel)}
          />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text>
                Orders scoring at or above these thresholds are flagged. Adjust
                based on your store's RTO rate.
              </s-text>
            </s-paragraph>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <ThresholdInput
                label="High Risk cutoff"
                name="highThreshold"
                defaultValue={settings.highThreshold}
                color="#d72c0d"
                hint="Score ≥ this → High (block / review)"
              />
              <ThresholdInput
                label="Medium Risk cutoff"
                name="medThreshold"
                defaultValue={settings.medThreshold}
                color="#b98900"
                hint="Score ≥ this → Medium (manual review)"
              />
            </div>

            <div>
              <s-button
                variant="primary"
                {...(isSaving ? { loading: true } : {})}
                onClick={(e: React.MouseEvent) =>
                  (e.target as HTMLElement).closest("form")?.requestSubmit()
                }
              >
                Save Thresholds
              </s-button>
            </div>
          </s-stack>
        </fetcher.Form>
      </s-section>

      {/* Auto-cancel */}
      <s-section heading="Auto-Actions">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>
              When enabled, high-risk COD orders are automatically cancelled
              in Shopify during a scan. Use with caution — this is irreversible
              without manual intervention.
            </s-text>
          </s-paragraph>

          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <AutoCancelToggle
              currentValue={settings.autoCancel}
              thresholds={{
                high: settings.highThreshold,
                med: settings.medThreshold,
              }}
              isSaving={isSaving}
            />
          </div>
        </s-stack>
      </s-section>

      {/* Blocked Phones */}
      <s-section heading="Blocked Phone Numbers">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>
              Orders from these phone numbers automatically score +20 risk
              points.
            </s-text>
          </s-paragraph>

          <fetcher.Form method="POST" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="add-phone" />
            <div>
              <div style={labelStyle}>Phone number (10 digits)</div>
              <input
                type="tel"
                name="phone"
                placeholder="9876543210"
                style={inputStyle}
                required
              />
            </div>
            <s-button
              {...(isSaving ? { loading: true } : {})}
              onClick={(e: React.MouseEvent) =>
                (e.target as HTMLElement).closest("form")?.requestSubmit()
              }
            >
              Add
            </s-button>
          </fetcher.Form>

          {blockedPhones.length > 0 && (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Phone</th>
                  <th style={thStyle}>Added</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {blockedPhones.map((p) => (
                  <tr key={p.id}>
                    <td style={tdStyle}><s-text>{p.phone}</s-text></td>
                    <td style={tdStyle}>
                      <s-text tone="subdued">
                        {new Date(p.createdAt).toLocaleDateString()}
                      </s-text>
                    </td>
                    <td style={tdStyle}>
                      <RemoveButton id={p.id} isSaving={isSaving} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {blockedPhones.length === 0 && (
            <s-text tone="subdued">No blocked phones yet.</s-text>
          )}
        </s-stack>
      </s-section>

      {/* Blocked Addresses */}
      <s-section heading="Blocked Delivery Addresses">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>
              Orders shipping to these addresses automatically score +30 risk
              points. Enter address in lowercase (e.g. "123 main st|mumbai|mh").
            </s-text>
          </s-paragraph>

          <fetcher.Form method="POST" style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="add-address" />
            <div style={{ flex: 1 }}>
              <div style={labelStyle}>Address (address1|city|state)</div>
              <input
                type="text"
                name="address"
                placeholder="123 main st|mumbai|mh"
                style={{ ...inputStyle, width: "100%" }}
                required
              />
            </div>
            <s-button
              {...(isSaving ? { loading: true } : {})}
              onClick={(e: React.MouseEvent) =>
                (e.target as HTMLElement).closest("form")?.requestSubmit()
              }
            >
              Add
            </s-button>
          </fetcher.Form>

          {blockedAddresses.length > 0 && (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Address</th>
                  <th style={thStyle}>Added</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {blockedAddresses.map((a) => (
                  <tr key={a.id}>
                    <td style={tdStyle}><s-text>{a.address}</s-text></td>
                    <td style={tdStyle}>
                      <s-text tone="subdued">
                        {new Date(a.createdAt).toLocaleDateString()}
                      </s-text>
                    </td>
                    <td style={tdStyle}>
                      <RemoveButton id={a.id} isSaving={isSaving} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {blockedAddresses.length === 0 && (
            <s-text tone="subdued">No blocked addresses yet.</s-text>
          )}
        </s-stack>
      </s-section>

      {/* Aside */}
      <s-section slot="aside" heading="Scoring guide">
        <s-stack direction="block" gap="tight">
          <s-paragraph><s-text fontWeight="semibold">+40</s-text><s-text> Past RTO customer</s-text></s-paragraph>
          <s-paragraph><s-text fontWeight="semibold">+30</s-text><s-text> Blocked address match</s-text></s-paragraph>
          <s-paragraph><s-text fontWeight="semibold">+20</s-text><s-text> Blocked phone or bad IP</s-text></s-paragraph>
          <s-paragraph><s-text fontWeight="semibold">+15</s-text><s-text> First-time customer</s-text></s-paragraph>
          <s-paragraph><s-text fontWeight="semibold">+10</s-text><s-text> COD payment base</s-text></s-paragraph>
          <s-paragraph><s-text fontWeight="semibold">+5</s-text><s-text> Order value &gt; ₹2000</s-text></s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ThresholdInput({
  label,
  name,
  defaultValue,
  color,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: number;
  color: string;
  hint: string;
}) {
  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: 8,
        border: `2px solid ${color}22`,
        background: `${color}08`,
        minWidth: 200,
      }}
    >
      <div style={{ fontSize: 13, color: "#6d7175", marginBottom: 4 }}>{label}</div>
      <input
        type="number"
        name={name}
        defaultValue={defaultValue}
        min={1}
        max={100}
        style={{
          fontSize: 28,
          fontWeight: 700,
          color,
          width: 80,
          border: "none",
          background: "transparent",
          outline: "none",
        }}
      />
      <div style={{ fontSize: 12, color: "#6d7175", marginTop: 4 }}>{hint}</div>
    </div>
  );
}

function AutoCancelToggle({
  currentValue,
  thresholds,
  isSaving,
}: {
  currentValue: boolean;
  thresholds: { high: number; med: number };
  isSaving: boolean;
}) {
  const fetcher = useFetcher();

  const toggle = () => {
    const fd = new FormData();
    fd.set("intent", "save-thresholds");
    fd.set("highThreshold", String(thresholds.high));
    fd.set("medThreshold", String(thresholds.med));
    fd.set("autoCancel", String(!currentValue));
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        onClick={toggle}
        style={{
          width: 48,
          height: 26,
          borderRadius: 13,
          background: currentValue ? "#d72c0d" : "#c9cccf",
          position: "relative",
          cursor: "pointer",
          transition: "background 0.2s",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 3,
            left: currentValue ? 25 : 3,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </div>
      <s-text fontWeight={currentValue ? "semibold" : "regular"}>
        {currentValue
          ? "Auto-cancel HIGH risk COD orders (enabled)"
          : "Auto-cancel HIGH risk COD orders (disabled)"}
      </s-text>
      {currentValue && (
        <s-badge tone="critical">Active</s-badge>
      )}
    </div>
  );
}

function RemoveButton({ id, isSaving }: { id: string; isSaving: boolean }) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="POST">
      <input type="hidden" name="intent" value="remove-entry" />
      <input type="hidden" name="id" value={id} />
      <s-button
        tone="critical"
        variant="tertiary"
        {...(isSaving ? { loading: true } : {})}
        onClick={(e: React.MouseEvent) =>
          (e.target as HTMLElement).closest("form")?.requestSubmit()
        }
      >
        Remove
      </s-button>
    </fetcher.Form>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  background: "#f6f6f7",
  borderBottom: "2px solid #e4e5e7",
  fontWeight: 600,
  color: "#3d4147",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #e4e5e7",
  verticalAlign: "middle",
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#6d7175",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #c9cccf",
  fontSize: 14,
  outline: "none",
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

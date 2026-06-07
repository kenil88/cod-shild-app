import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useEffect, useState, type CSSProperties } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const GET_COD_HIDE_CONFIG = `#graphql
  query GetCodHideConfig {
    paymentCustomizations(first: 25) {
      edges {
        node {
          id
          title
          enabled
          metafield(namespace: "$app:payment-customization", key: "cod-hide-rules") {
            value
          }
        }
      }
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

const METAFIELDS_SET = `#graphql
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace value }
      userErrors { field message code }
    }
  }
`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CodHideConfig {
  enabled: boolean;
  blocked_pincodes: string[];
  blocked_product_ids: string[];
  cart_max: number | null;
  cart_min: number | null;
}

const DEFAULT_CONFIG: CodHideConfig = {
  enabled: false,
  blocked_pincodes: [],
  blocked_product_ids: [],
  cart_max: null,
  cart_min: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseLines(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function nullableFloat(raw: FormDataEntryValue | null): number | null {
  if (!raw || String(raw).trim() === "") return null;
  const n = parseFloat(String(raw));
  return isNaN(n) ? null : n;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const res = await admin.graphql(GET_COD_HIDE_CONFIG);
  const { data } = await res.json();
  const customizations = (data?.paymentCustomizations?.edges ?? []).map(
    (e: { node: { id: string; title: string; enabled: boolean; metafield: { value: string } | null } }) => e.node
  );

  const ours = customizations.find(
    (c: { title: string }) => c.title === "COD Hide Payment"
  ) as { id: string; title: string; enabled: boolean; metafield: { value: string } | null } | undefined;

  let config: CodHideConfig = DEFAULT_CONFIG;
  if (ours?.metafield?.value) {
    try {
      config = JSON.parse(ours.metafield.value) as CodHideConfig;
    } catch {
      config = DEFAULT_CONFIG;
    }
  }

  const functionDeployed = Boolean(process.env.SHOPIFY_COD_HIDE_PAYMENT_ID);

  return {
    customizationId: ours?.id ?? null,
    functionDeployed,
    config,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const config: CodHideConfig = {
    enabled: form.get("enabled") === "true",
    blocked_pincodes: parseLines(String(form.get("pincodes") ?? "")),
    blocked_product_ids: parseLines(String(form.get("product_ids") ?? "")),
    cart_max: nullableFloat(form.get("cart_max")),
    cart_min: nullableFloat(form.get("cart_min")),
  };

  // Resolve the PaymentCustomization owner GID
  let ownerId = String(form.get("customizationId") ?? "").trim() || null;

  if (!ownerId) {
    const functionId = process.env.SHOPIFY_COD_HIDE_PAYMENT_ID;
    if (!functionId) {
      return {
        ok: false,
        error:
          "Payment customization function is not deployed yet. " +
          "Run `shopify app deploy` and set SHOPIFY_COD_HIDE_PAYMENT_ID in your env.",
      };
    }

    const createRes = await admin.graphql(CREATE_PAYMENT_CUSTOMIZATION, {
      variables: { input: { title: "COD Hide Payment", enabled: true, functionId } },
    });
    const { data: cd } = await createRes.json();
    const createErrors = cd?.paymentCustomizationCreate?.userErrors ?? [];
    if (createErrors.length > 0) {
      return { ok: false, error: (createErrors[0] as { message: string }).message };
    }
    ownerId = cd?.paymentCustomizationCreate?.paymentCustomization?.id ?? null;
  }

  if (!ownerId) {
    return { ok: false, error: "Could not resolve payment customization ID." };
  }

  const setRes = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: "$app:payment-customization",
          key: "cod-hide-rules",
          type: "json",
          value: JSON.stringify(config),
        },
      ],
    },
  });
  const { data: sd } = await setRes.json();
  const setErrors = sd?.metafieldsSet?.userErrors ?? [];
  if (setErrors.length > 0) {
    return { ok: false, error: (setErrors[0] as { message: string }).message };
  }

  return { ok: true, error: null, newCustomizationId: ownerId };
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CodVisibilityPage() {
  const { customizationId, functionDeployed, config } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const saving = fetcher.state !== "idle";

  const [enabled, setEnabled] = useState(config.enabled);
  const [pincodes, setPincodes] = useState(config.blocked_pincodes.join("\n"));
  const [productIds, setProductIds] = useState(config.blocked_product_ids.join("\n"));
  const [cartMax, setCartMax] = useState(config.cart_max !== null ? String(config.cart_max) : "");
  const [cartMin, setCartMin] = useState(config.cart_min !== null ? String(config.cart_min) : "");

  // Resolve the current customizationId — after a first-ever save the action
  // creates one and returns it; use it so subsequent saves update in place.
  const resolvedId =
    (fetcher.data?.newCustomizationId as string | undefined) ?? customizationId;

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.ok) {
        shopify.toast.show("COD visibility rules saved.");
      } else if (fetcher.data.error) {
        shopify.toast.show(fetcher.data.error, { isError: true });
      }
    }
  }, [fetcher.state, fetcher.data, shopify]);

  return (
    <s-page heading="COD Shield — COD Visibility Rules">

      {/* ── Deployment warning ── */}
      {!functionDeployed && (
        <s-section>
          <div style={bannerStyle("#fff8f0", "#ffc58b", "#7a4100")}>
            <strong>Function not deployed.</strong> Run{" "}
            <code style={{ background: "#fde8cc", padding: "1px 6px", borderRadius: 4 }}>
              shopify app deploy
            </code>{" "}
            and add <code style={{ background: "#fde8cc", padding: "1px 6px", borderRadius: 4 }}>
              SHOPIFY_COD_HIDE_PAYMENT_ID
            </code>{" "}
            to your environment variables, then redeploy the app before saving rules.
          </div>
        </s-section>
      )}

      <fetcher.Form method="POST">
        <input type="hidden" name="enabled" value={String(enabled)} />
        <input type="hidden" name="customizationId" value={resolvedId ?? ""} />

        {/* ── Master toggle ── */}
        <s-section heading="Feature Status">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "14px 16px",
              borderRadius: 8,
              background: enabled ? "#f4fff8" : "#f6f6f7",
              border: `1px solid ${enabled ? "#d3f5e5" : "#e4e5e7"}`,
            }}
          >
            <div
              onClick={() => setEnabled(!enabled)}
              style={{
                width: 44,
                height: 24,
                borderRadius: 12,
                background: enabled ? "#008060" : "#c9cccf",
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
                  left: enabled ? 23 : 3,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                }}
              />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: enabled ? "#008060" : "#3d4147" }}>
                {enabled ? "COD Hide Rules are ACTIVE" : "COD Hide Rules are INACTIVE"}
              </div>
              <div style={{ fontSize: 12, color: "#6d7175", marginTop: 2 }}>
                {enabled
                  ? "The function evaluates pincode, product, and cart total rules on every checkout."
                  : "Cash on Delivery is shown to all customers regardless of rules below."}
              </div>
            </div>
          </div>
        </s-section>

        {/* ── Pincode Rules ── */}
        <s-section heading="Pincode Rules">
          <p style={{ fontSize: 13, color: "#6d7175", margin: "0 0 12px" }}>
            COD will be hidden when the buyer's delivery pincode matches any entry below.
            Enter one pincode per line (or comma-separated). If no pincode can be read
            (e.g. on a checkout refresh), COD remains visible — see fail-open policy.
          </p>
          <div style={labelStyle}>Blocked pincodes</div>
          <textarea
            name="pincodes"
            value={pincodes}
            onChange={(e) => setPincodes(e.target.value)}
            rows={5}
            placeholder={"110001\n400001\n560001"}
            style={textareaStyle}
          />
          {pincodes.trim() && (
            <div style={{ fontSize: 12, color: "#6d7175", marginTop: 4 }}>
              {parseLines(pincodes).length} pincode(s) configured
            </div>
          )}
        </s-section>

        {/* ── Product Rules ── */}
        <s-section heading="Product Rules">
          <p style={{ fontSize: 13, color: "#6d7175", margin: "0 0 12px" }}>
            COD will be hidden when any of these products is in the cart. Enter one
            Shopify Product GID per line (format:{" "}
            <code style={{ fontSize: 11 }}>gid://shopify/Product/123456789</code>).
          </p>
          <div style={labelStyle}>Blocked product GIDs</div>
          <textarea
            name="product_ids"
            value={productIds}
            onChange={(e) => setProductIds(e.target.value)}
            rows={4}
            placeholder={"gid://shopify/Product/123456789\ngid://shopify/Product/987654321"}
            style={textareaStyle}
          />
          {productIds.trim() && (
            <div style={{ fontSize: 12, color: "#6d7175", marginTop: 4 }}>
              {parseLines(productIds).length} product(s) configured
            </div>
          )}
        </s-section>

        {/* ── Cart Total Rules ── */}
        <s-section heading="Cart Total Rules">
          <p style={{ fontSize: 13, color: "#6d7175", margin: "0 0 16px" }}>
            Hide COD when the cart total falls outside a range. Leave a field blank to
            disable that bound.
          </p>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div style={labelStyle}>Hide COD when total is ABOVE (₹)</div>
              <input
                type="number"
                name="cart_max"
                value={cartMax}
                onChange={(e) => setCartMax(e.target.value)}
                placeholder="e.g. 5000"
                min={0}
                step={100}
                style={inputStyle}
              />
            </div>
            <div>
              <div style={labelStyle}>Hide COD when total is BELOW (₹)</div>
              <input
                type="number"
                name="cart_min"
                value={cartMin}
                onChange={(e) => setCartMin(e.target.value)}
                placeholder="e.g. 200"
                min={0}
                step={50}
                style={inputStyle}
              />
            </div>
          </div>
        </s-section>

        {/* ── Save ── */}
        <div style={{ padding: "20px 0 24px" }}>
          <button
            type="submit"
            disabled={saving || !functionDeployed}
            style={{
              padding: "11px 28px",
              borderRadius: 8,
              background: saving || !functionDeployed ? "#c9cccf" : "#008060",
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
              border: "none",
              cursor: saving || !functionDeployed ? "default" : "pointer",
              transition: "background 0.2s",
              letterSpacing: "0.2px",
            }}
          >
            {saving ? "Saving…" : "Save Rules"}
          </button>
        </div>
      </fetcher.Form>

      {/* ── Aside ── */}
      <s-section slot="aside" heading="How it works">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13, color: "#3d4147" }}>
          <HowItWorksItem
            icon="📍"
            title="Pincode rule"
            body="Checked against the shipping address entered at checkout. If the address hasn't loaded yet (e.g. page refresh), COD stays visible — fail-open."
          />
          <HowItWorksItem
            icon="📦"
            title="Product rule"
            body="Evaluated against cart line items. Any single matching product hides COD for the whole cart."
          />
          <HowItWorksItem
            icon="💰"
            title="Cart total rule"
            body="Hides COD when total exceeds the max or falls below the min. Leave a bound blank to ignore it."
          />
          <div style={{ paddingTop: 8, borderTop: "1px solid #e4e5e7", fontSize: 12, color: "#6d7175" }}>
            Rules are OR'd: any matching rule hides COD. Changes take effect immediately — no Shopify plan upgrade required.
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

function HowItWorksItem({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#6d7175", lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: CSSProperties = { fontSize: 12, color: "#6d7175", marginBottom: 4, fontWeight: 600 };

const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #c9cccf",
  fontSize: 13,
  fontFamily: "monospace",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #c9cccf",
  fontSize: 14,
  outline: "none",
  width: 160,
};

function bannerStyle(bg: string, border: string, color: string): CSSProperties {
  return {
    padding: "12px 16px",
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 8,
    color,
    fontSize: 13,
    lineHeight: 1.6,
  };
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

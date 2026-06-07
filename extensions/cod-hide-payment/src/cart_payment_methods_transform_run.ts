import type {
  CartPaymentMethodsTransformRunInput,
  CartPaymentMethodsTransformRunResult,
} from "../generated/api";

const COD_PATTERNS = [
  "cash on delivery",
  "cash-on-delivery",
  "cod",
  "pay on delivery",
];

interface CodHideConfig {
  enabled: boolean;
  blocked_pincodes: string[];
  blocked_product_ids: string[];
  cart_max: number | null;
  cart_min: number | null;
}

export function cartPaymentMethodsTransformRun(
  input: CartPaymentMethodsTransformRunInput
): CartPaymentMethodsTransformRunResult {
  const raw = input.paymentCustomization.metafield;
  if (!raw) return { operations: [] };

  const config = raw.jsonValue as CodHideConfig;
  if (!config?.enabled) return { operations: [] };

  const codMethod = input.paymentMethods.find((m) =>
    COD_PATTERNS.some((p) => m.name.toLowerCase().includes(p))
  );
  if (!codMethod) return { operations: [] };

  // ── Rule 1: Pincode ───────────────────────────────────────────────────────
  //
  // FAIL-OPEN (intentional product decision): Shopify can deliver a null
  // deliveryAddress even after the buyer has entered a shipping address — this
  // happens on a hard checkout page refresh. If we cannot read the zip we must
  // NOT hide COD. Blocking a legitimate customer on a transient null is worse
  // than momentarily showing COD to a blocked pincode.
  //
  // Product and cart-total rules are address-independent and still run below.
  if (config.blocked_pincodes?.length > 0) {
    // Guard every level independently:
    //   - deliveryGroups may be empty (index 0 returns undefined)
    //   - deliveryAddress may be null even when the group exists
    //   - zip may be null even when deliveryAddress exists
    const zip = input.cart.deliveryGroups[0]?.deliveryAddress?.zip ?? null;

    if (zip !== null && config.blocked_pincodes.includes(zip)) {
      return hideCod(codMethod.id);
    }
    // zip === null → fail-open: skip this rule, continue to product / value rules
  }

  // ── Rule 2: Product ───────────────────────────────────────────────────────
  // Cart lines are always populated; this rule does NOT depend on the delivery
  // address being present.
  if (config.blocked_product_ids?.length > 0) {
    const blocked = new Set(config.blocked_product_ids);
    for (const line of input.cart.lines) {
      const merch = line.merchandise;
      if (merch.__typename === "ProductVariant" && blocked.has(merch.product.id)) {
        return hideCod(codMethod.id);
      }
    }
  }

  // ── Rule 3: Cart total ────────────────────────────────────────────────────
  // The cart total is always available; this rule does NOT depend on the
  // delivery address being present.
  const total = parseFloat(input.cart.cost.totalAmount.amount);
  if (config.cart_max !== null && total > config.cart_max) return hideCod(codMethod.id);
  if (config.cart_min !== null && total < config.cart_min) return hideCod(codMethod.id);

  return { operations: [] };
}

function hideCod(paymentMethodId: string): CartPaymentMethodsTransformRunResult {
  return { operations: [{ paymentMethodHide: { paymentMethodId } }] };
}

/*
 * ── Test note ────────────────────────────────────────────────────────────────
 *
 * To reproduce the null-deliveryAddress case described in the fail-open policy:
 *
 * 1. Add a product to the cart and reach the Payment step of checkout.
 * 2. At the Payment step, press ⌘R / F5 to do a hard browser refresh.
 * 3. On the refreshed page, the payment step re-renders before Shopify has
 *    re-populated the delivery groups. At this moment deliveryAddress is null
 *    even though the buyer has already entered their shipping address.
 *
 * Expected behaviour (fail-open):
 * - The pincode rule is skipped (zip cannot be read).
 * - COD remains visible during this transient state.
 * - The product and cart-total rules still evaluate normally.
 * - Once the page has fully loaded and delivery groups are populated, a
 *   subsequent function invocation will re-evaluate the pincode rule correctly.
 *
 * Verify by adding the buyer's pincode to blocked_pincodes in the config
 * metafield and confirming COD appears during the refresh moment but is hidden
 * on a clean page load to the same checkout.
 */

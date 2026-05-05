// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalKey =
  | "new_customer"
  | "high_rto_pincode"
  | "unusual_quantity"
  | "night_order"
  | "incomplete_address"
  | "past_rto_history"
  | "multiple_addresses"
  | "order_velocity";

export type RiskLevel = "safe" | "medium" | "high";
export type RiskAction = "approve" | "review" | "cancel";

export interface LineItem {
  quantity: number;
}

export interface OrderInput {
  shopifyOrderId: string;
  orderNumber: string;
  paymentMethod: string;
  totalPrice: number;
  lineItems: LineItem[];
  createdAt: string; // ISO-8601
  customer?: {
    id: string;
    phone?: string | null;
    email?: string | null;
    ordersCount: number;
  } | null;
  shippingAddress?: {
    address1?: string | null;
    city?: string | null;
    zip?: string | null;
    phone?: string | null;
  } | null;
  ip?: string | null;
}

export interface CustomerHistory {
  rtoCount: number;       // confirmed RTO orders by this customer
  totalOrders: number;    // lifetime orders
  uniqueAddresses: number; // distinct shipping addresses used
  recentOrderCount: number; // orders in last 24 h (same phone/email)
}

export interface PincodeStats {
  totalOrders: number;
  rtoCount: number;
  rtoRate: number; // 0–1 fraction
}

export interface IpStats {
  orderCount: number; // orders from this IP in the velocity window
  flagCount: number;  // times this IP was previously flagged
}

export interface RulesConfig {
  // toggles
  newCustomer: boolean;
  highRtoPincode: boolean;
  unusualQuantity: boolean;
  nightOrder: boolean;
  incompleteAddress: boolean;
  pastRtoHistory: boolean;
  multipleAddresses: boolean;
  orderVelocity: boolean;
  // weights (all default to 100-point budget)
  newCustomerWeight: number;
  highRtoPincodeWeight: number;
  unusualQuantityWeight: number;
  nightOrderWeight: number;
  incompleteAddressWeight: number;
  pastRtoHistoryWeight: number;
  multipleAddressesWeight: number;
  orderVelocityWeight: number;
  // action thresholds
  autoCancelThreshold: number;
  autoCancel?: boolean;
  highValueThreshold?: number; // skip auto-cancel for orders above this ₹ amount
}

export interface SignalResult {
  key: SignalKey;
  label: string;
  triggered: boolean;
  weight: number; // 0 when signal is disabled
  reason: string;
}

export interface RiskResult {
  score: number;            // 0–100
  level: RiskLevel;
  action: RiskAction;
  signals: SignalResult[];
  triggeredSignals: SignalKey[];
}

// Default rules (matches DB defaults)
export const DEFAULT_RULES: RulesConfig = {
  newCustomer: true,
  highRtoPincode: true,
  unusualQuantity: true,
  nightOrder: true,
  incompleteAddress: true,
  pastRtoHistory: true,
  multipleAddresses: true,
  orderVelocity: true,
  newCustomerWeight: 12,
  highRtoPincodeWeight: 20,
  unusualQuantityWeight: 8,
  nightOrderWeight: 3,
  incompleteAddressWeight: 4,
  pastRtoHistoryWeight: 25,
  multipleAddressesWeight: 10,
  orderVelocityWeight: 18,
  autoCancelThreshold: 75,
  highValueThreshold: 5000,
};

// ─── Thresholds ────────────────────────────────────────────────────────────────

const HIGH_RTO_PINCODE_RATE = 0.3;   // ≥30% RTO rate → flag
const MIN_PINCODE_ORDERS = 5;         // need ≥5 orders before trusting rate
const UNUSUAL_QTY_PER_ITEM = 5;      // any single line-item qty > this
const UNUSUAL_QTY_TOTAL = 15;        // total items across all lines > this
const NIGHT_HOUR_START = 23;         // 11pm IST
const NIGHT_HOUR_END = 4;            // 4am IST
const MULTIPLE_ADDRESS_THRESHOLD = 3; // > this many distinct addresses
const VELOCITY_IP_THRESHOLD = 3;     // ≥ this orders from same IP in window
const VELOCITY_CUSTOMER_THRESHOLD = 2; // ≥ this orders from same customer in 24h

// ─── Signal evaluators ────────────────────────────────────────────────────────

function evalNewCustomer(
  order: OrderInput,
  history: CustomerHistory,
  weight: number,
  enabled: boolean
): SignalResult {
  const ordersCount = order.customer?.ordersCount ?? 0;
  const isGuest = !order.customer;
  const triggered =
    enabled && (isGuest || ordersCount <= 1) && history.totalOrders <= 1;
  return {
    key: "new_customer",
    label: "New / first-time customer",
    triggered,
    weight: enabled ? weight : 0,
    reason: isGuest
      ? "Guest checkout — no customer account"
      : `Customer has ${ordersCount} previous order(s)`,
  };
}

function evalHighRtoPincode(
  order: OrderInput,
  pincodeStats: PincodeStats | null,
  weight: number,
  enabled: boolean
): SignalResult {
  const pincode = order.shippingAddress?.zip ?? "";
  const hasEnoughData =
    pincodeStats !== null && pincodeStats.totalOrders >= MIN_PINCODE_ORDERS;
  const triggered =
    enabled &&
    hasEnoughData &&
    pincodeStats!.rtoRate >= HIGH_RTO_PINCODE_RATE;

  const rateStr = pincodeStats
    ? `${(pincodeStats.rtoRate * 100).toFixed(1)}% RTO rate (${pincodeStats.rtoCount}/${pincodeStats.totalOrders} orders)`
    : "no pincode data yet";

  return {
    key: "high_rto_pincode",
    label: "High-RTO pincode",
    triggered,
    weight: enabled ? weight : 0,
    reason: pincode
      ? `Pincode ${pincode}: ${rateStr}`
      : "No pincode in shipping address",
  };
}

function evalUnusualQuantity(
  order: OrderInput,
  weight: number,
  enabled: boolean
): SignalResult {
  const totalQty = order.lineItems.reduce((s, i) => s + i.quantity, 0);
  const maxSingleQty = Math.max(0, ...order.lineItems.map((i) => i.quantity));
  const triggered =
    enabled &&
    (totalQty > UNUSUAL_QTY_TOTAL || maxSingleQty > UNUSUAL_QTY_PER_ITEM);
  return {
    key: "unusual_quantity",
    label: "Unusual item quantity",
    triggered,
    weight: enabled ? weight : 0,
    reason: `${totalQty} total items (max single line: ${maxSingleQty})`,
  };
}

function evalNightOrder(
  order: OrderInput,
  weight: number,
  enabled: boolean
): SignalResult {
  // Convert UTC to IST (UTC+5:30)
  const utcMs = new Date(order.createdAt).getTime();
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  const hourIST = new Date(istMs).getUTCHours();
  const isNight =
    hourIST >= NIGHT_HOUR_START || hourIST < NIGHT_HOUR_END;
  const triggered = enabled && isNight;
  return {
    key: "night_order",
    label: "Late-night order",
    triggered,
    weight: enabled ? weight : 0,
    reason: `Placed at ${hourIST}:00 IST (${NIGHT_HOUR_START}:00–${NIGHT_HOUR_END}:00 = night window)`,
  };
}

function evalIncompleteAddress(
  order: OrderInput,
  weight: number,
  enabled: boolean
): SignalResult {
  const addr = order.shippingAddress;
  const missing: string[] = [];

  if (!addr) {
    return {
      key: "incomplete_address",
      label: "Incomplete shipping address",
      triggered: enabled,
      weight: enabled ? weight : 0,
      reason: "No shipping address provided",
    };
  }

  if (!addr.address1 || addr.address1.trim().length < 5) missing.push("street");
  if (!addr.city || addr.city.trim().length < 2) missing.push("city");
  if (!addr.zip || !/^\d{6}$/.test(addr.zip.trim())) missing.push("valid 6-digit pincode");

  const triggered = enabled && missing.length > 0;
  return {
    key: "incomplete_address",
    label: "Incomplete shipping address",
    triggered,
    weight: enabled ? weight : 0,
    reason: triggered
      ? `Missing or invalid: ${missing.join(", ")}`
      : "Address looks complete",
  };
}

function evalPastRtoHistory(
  history: CustomerHistory,
  weight: number,
  enabled: boolean
): SignalResult {
  const triggered = enabled && history.rtoCount > 0;
  return {
    key: "past_rto_history",
    label: "Past RTO history",
    triggered,
    weight: enabled ? weight : 0,
    reason: triggered
      ? `${history.rtoCount} confirmed RTO order(s) on record`
      : "No RTO history found",
  };
}

function evalMultipleAddresses(
  history: CustomerHistory,
  weight: number,
  enabled: boolean
): SignalResult {
  const triggered =
    enabled && history.uniqueAddresses > MULTIPLE_ADDRESS_THRESHOLD;
  return {
    key: "multiple_addresses",
    label: "Multiple shipping addresses",
    triggered,
    weight: enabled ? weight : 0,
    reason: `${history.uniqueAddresses} distinct delivery addresses used`,
  };
}

function evalOrderVelocity(
  history: CustomerHistory,
  ipStats: IpStats | null,
  weight: number,
  enabled: boolean
): SignalResult {
  const ipFlag =
    ipStats !== null && ipStats.orderCount >= VELOCITY_IP_THRESHOLD;
  const customerFlag =
    history.recentOrderCount >= VELOCITY_CUSTOMER_THRESHOLD;
  const triggered = enabled && (ipFlag || customerFlag);

  const reasons: string[] = [];
  if (ipFlag) reasons.push(`${ipStats!.orderCount} orders from same IP in window`);
  if (customerFlag)
    reasons.push(`${history.recentOrderCount} orders from same customer in 24h`);

  return {
    key: "order_velocity",
    label: "High order velocity",
    triggered,
    weight: enabled ? weight : 0,
    reason: reasons.length ? reasons.join("; ") : "Velocity within normal range",
  };
}

// ─── Main scoring function ────────────────────────────────────────────────────

export function scoreOrder(
  order: OrderInput,
  customerHistory: CustomerHistory,
  pincodeStats: PincodeStats | null,
  ipStats: IpStats | null,
  rules: RulesConfig = DEFAULT_RULES
): RiskResult {
  const signals: SignalResult[] = [
    evalNewCustomer(order, customerHistory, rules.newCustomerWeight, rules.newCustomer),
    evalHighRtoPincode(order, pincodeStats, rules.highRtoPincodeWeight, rules.highRtoPincode),
    evalUnusualQuantity(order, rules.unusualQuantityWeight, rules.unusualQuantity),
    evalNightOrder(order, rules.nightOrderWeight, rules.nightOrder),
    evalIncompleteAddress(order, rules.incompleteAddressWeight, rules.incompleteAddress),
    evalPastRtoHistory(customerHistory, rules.pastRtoHistoryWeight, rules.pastRtoHistory),
    evalMultipleAddresses(customerHistory, rules.multipleAddressesWeight, rules.multipleAddresses),
    evalOrderVelocity(customerHistory, ipStats, rules.orderVelocityWeight, rules.orderVelocity),
  ];

  const rawScore = signals.reduce(
    (sum, s) => sum + (s.triggered ? s.weight : 0),
    0
  );
  const score = Math.min(100, rawScore);

  const level: RiskLevel =
    score >= 60 ? "high" : score >= 30 ? "medium" : "safe";

  // Respect the merchant's custom auto-cancel threshold
  const effectiveHighThreshold = rules.autoCancelThreshold ?? 75;
  const action: RiskAction =
    score >= effectiveHighThreshold
      ? "cancel"
      : score >= 30
        ? "review"
        : "approve";

  const triggeredSignals = signals
    .filter((s) => s.triggered)
    .map((s) => s.key);

  return { score, level, action, signals, triggeredSignals };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function levelColor(level: RiskLevel): string {
  return level === "high" ? "#d72c0d" : level === "medium" ? "#b98900" : "#1a7a4a";
}

export function levelTone(
  level: RiskLevel
): "critical" | "warning" | "success" {
  return level === "high"
    ? "critical"
    : level === "medium"
      ? "warning"
      : "success";
}

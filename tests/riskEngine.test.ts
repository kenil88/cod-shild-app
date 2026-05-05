import { describe, it, expect } from "vitest";
import {
  scoreOrder,
  DEFAULT_RULES,
  type OrderInput,
  type CustomerHistory,
  type PincodeStats,
  type IpStats,
  type RulesConfig,
} from "../app/lib/riskEngine";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const BASE_ORDER: OrderInput = {
  shopifyOrderId: "gid://shopify/Order/1",
  orderNumber: "1001",
  paymentMethod: "Cash on Delivery",
  totalPrice: 499,
  lineItems: [{ quantity: 1 }],
  createdAt: "2024-06-15T10:00:00.000Z", // 3:30 pm IST — not night
  customer: {
    id: "cust_1",
    phone: "9876543210",
    email: "test@example.com",
    ordersCount: 5,
  },
  shippingAddress: {
    address1: "123 Main Street",
    city: "Mumbai",
    zip: "400001",
    phone: "9876543210",
  },
  ip: "1.2.3.4",
};

const CLEAN_HISTORY: CustomerHistory = {
  rtoCount: 0,
  totalOrders: 5,
  uniqueAddresses: 1,
  recentOrderCount: 0,
};

const NO_PINCODE: PincodeStats | null = null;
const NO_IP: IpStats | null = null;

// Helper — clone order with partial overrides
function order(overrides: Partial<OrderInput> = {}): OrderInput {
  return { ...BASE_ORDER, ...overrides };
}
function history(overrides: Partial<CustomerHistory> = {}): CustomerHistory {
  return { ...CLEAN_HISTORY, ...overrides };
}

// Rules with a single signal enabled (all others off)
function onlySignal(key: keyof RulesConfig): RulesConfig {
  return {
    ...DEFAULT_RULES,
    newCustomer: false,
    highRtoPincode: false,
    unusualQuantity: false,
    nightOrder: false,
    incompleteAddress: false,
    pastRtoHistory: false,
    multipleAddresses: false,
    orderVelocity: false,
    [key]: true,
  };
}

// ─── 1. new_customer ──────────────────────────────────────────────────────────

describe("signal: new_customer (weight 12)", () => {
  const rules = onlySignal("newCustomer");

  it("triggers for a guest checkout (no customer)", () => {
    const result = scoreOrder(
      order({ customer: null }),
      history({ totalOrders: 0 }),
      NO_PINCODE,
      NO_IP,
      rules
    );
    expect(result.triggeredSignals).toContain("new_customer");
    expect(result.score).toBe(12);
  });

  it("triggers for first-time customer with 1 order in history", () => {
    const result = scoreOrder(
      order({ customer: { id: "c1", phone: null, email: null, ordersCount: 1 } }),
      history({ totalOrders: 1 }),
      NO_PINCODE,
      NO_IP,
      rules
    );
    expect(result.triggeredSignals).toContain("new_customer");
  });

  it("does NOT trigger for returning customer with 5 orders", () => {
    const result = scoreOrder(
      order({ customer: { id: "c1", phone: null, email: null, ordersCount: 5 } }),
      history({ totalOrders: 5 }),
      NO_PINCODE,
      NO_IP,
      rules
    );
    expect(result.triggeredSignals).not.toContain("new_customer");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger when signal is disabled", () => {
    const result = scoreOrder(
      order({ customer: null }),
      history({ totalOrders: 0 }),
      NO_PINCODE,
      NO_IP,
      { ...DEFAULT_RULES, newCustomer: false }
    );
    expect(result.triggeredSignals).not.toContain("new_customer");
  });
});

// ─── 2. high_rto_pincode ──────────────────────────────────────────────────────

describe("signal: high_rto_pincode (weight 20)", () => {
  const rules = onlySignal("highRtoPincode");

  it("triggers when pincode RTO rate >= 30% with enough data", () => {
    const stats: PincodeStats = { totalOrders: 10, rtoCount: 4, rtoRate: 0.4 };
    const result = scoreOrder(order(), history(), stats, NO_IP, rules);
    expect(result.triggeredSignals).toContain("high_rto_pincode");
    expect(result.score).toBe(20);
  });

  it("does NOT trigger when RTO rate is exactly 29%", () => {
    const stats: PincodeStats = { totalOrders: 10, rtoCount: 2, rtoRate: 0.29 };
    const result = scoreOrder(order(), history(), stats, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("high_rto_pincode");
  });

  it("does NOT trigger when fewer than 5 orders exist for the pincode", () => {
    const stats: PincodeStats = { totalOrders: 3, rtoCount: 2, rtoRate: 0.67 };
    const result = scoreOrder(order(), history(), stats, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("high_rto_pincode");
  });

  it("does NOT trigger when pincode stats are null", () => {
    const result = scoreOrder(order(), history(), null, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("high_rto_pincode");
  });
});

// ─── 3. unusual_quantity ──────────────────────────────────────────────────────

describe("signal: unusual_quantity (weight 8)", () => {
  const rules = onlySignal("unusualQuantity");

  it("triggers when a single line item has qty > 5", () => {
    const result = scoreOrder(
      order({ lineItems: [{ quantity: 6 }] }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("unusual_quantity");
    expect(result.score).toBe(8);
  });

  it("triggers when total quantity across lines > 15", () => {
    const result = scoreOrder(
      order({ lineItems: [{ quantity: 8 }, { quantity: 9 }] }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("unusual_quantity");
  });

  it("does NOT trigger for normal single-item order", () => {
    const result = scoreOrder(
      order({ lineItems: [{ quantity: 2 }] }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).not.toContain("unusual_quantity");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger when qty is exactly at threshold (5 items)", () => {
    const result = scoreOrder(
      order({ lineItems: [{ quantity: 5 }] }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).not.toContain("unusual_quantity");
  });
});

// ─── 4. night_order ───────────────────────────────────────────────────────────

describe("signal: night_order (weight 3)", () => {
  const rules = onlySignal("nightOrder");

  // IST = UTC + 5:30. So 11pm IST = 17:30 UTC, 4am IST = 22:30 UTC prev day.
  it("triggers for order at 11:30 pm IST (18:00 UTC)", () => {
    const result = scoreOrder(
      order({ createdAt: "2024-06-15T18:00:00.000Z" }), // 11:30 pm IST
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("night_order");
    expect(result.score).toBe(3);
  });

  it("triggers for order at 2 am IST (20:30 UTC prev day)", () => {
    const result = scoreOrder(
      order({ createdAt: "2024-06-14T20:30:00.000Z" }), // 2:00 am IST
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("night_order");
  });

  it("does NOT trigger for order at 10 am IST (04:30 UTC)", () => {
    const result = scoreOrder(
      order({ createdAt: "2024-06-15T04:30:00.000Z" }), // 10:00 am IST
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).not.toContain("night_order");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger at exactly 4 am IST (22:30 UTC)", () => {
    const result = scoreOrder(
      order({ createdAt: "2024-06-14T22:30:00.000Z" }), // exactly 4:00 am IST
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).not.toContain("night_order");
  });
});

// ─── 5. incomplete_address ────────────────────────────────────────────────────

describe("signal: incomplete_address (weight 4)", () => {
  const rules = onlySignal("incompleteAddress");

  it("triggers when no shipping address provided", () => {
    const result = scoreOrder(
      order({ shippingAddress: null }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("incomplete_address");
    expect(result.score).toBe(4);
  });

  it("triggers when address1 is too short (< 5 chars)", () => {
    const result = scoreOrder(
      order({ shippingAddress: { address1: "Apt", city: "Mumbai", zip: "400001", phone: null } }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("incomplete_address");
  });

  it("triggers when zip is not 6 digits", () => {
    const result = scoreOrder(
      order({ shippingAddress: { address1: "123 Main St", city: "Mumbai", zip: "4000", phone: null } }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("incomplete_address");
  });

  it("triggers when city is missing", () => {
    const result = scoreOrder(
      order({ shippingAddress: { address1: "123 Main St", city: "", zip: "400001", phone: null } }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).toContain("incomplete_address");
  });

  it("does NOT trigger for complete valid address", () => {
    const result = scoreOrder(
      order({ shippingAddress: { address1: "123 Main Street", city: "Mumbai", zip: "400001", phone: null } }),
      history(), NO_PINCODE, NO_IP, rules
    );
    expect(result.triggeredSignals).not.toContain("incomplete_address");
    expect(result.score).toBe(0);
  });
});

// ─── 6. past_rto_history ─────────────────────────────────────────────────────

describe("signal: past_rto_history (weight 25)", () => {
  const rules = onlySignal("pastRtoHistory");

  it("triggers when customer has 1 RTO on record", () => {
    const result = scoreOrder(order(), history({ rtoCount: 1 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).toContain("past_rto_history");
    expect(result.score).toBe(25);
  });

  it("triggers when customer has multiple RTOs", () => {
    const result = scoreOrder(order(), history({ rtoCount: 3 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).toContain("past_rto_history");
  });

  it("does NOT trigger when rtoCount is 0", () => {
    const result = scoreOrder(order(), history({ rtoCount: 0 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("past_rto_history");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger when signal is disabled", () => {
    const result = scoreOrder(
      order(),
      history({ rtoCount: 5 }),
      NO_PINCODE,
      NO_IP,
      { ...DEFAULT_RULES, pastRtoHistory: false }
    );
    expect(result.triggeredSignals).not.toContain("past_rto_history");
  });
});

// ─── 7. multiple_addresses ────────────────────────────────────────────────────

describe("signal: multiple_addresses (weight 10)", () => {
  const rules = onlySignal("multipleAddresses");

  it("triggers when customer has used 4 distinct addresses", () => {
    const result = scoreOrder(order(), history({ uniqueAddresses: 4 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).toContain("multiple_addresses");
    expect(result.score).toBe(10);
  });

  it("does NOT trigger at exactly 3 addresses (threshold is >3)", () => {
    const result = scoreOrder(order(), history({ uniqueAddresses: 3 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("multiple_addresses");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger for 1 address", () => {
    const result = scoreOrder(order(), history({ uniqueAddresses: 1 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("multiple_addresses");
  });
});

// ─── 8. order_velocity ────────────────────────────────────────────────────────

describe("signal: order_velocity (weight 18)", () => {
  const rules = onlySignal("orderVelocity");

  it("triggers when IP has >= 3 orders in window", () => {
    const ipStats: IpStats = { orderCount: 3, flagCount: 0 };
    const result = scoreOrder(order(), history(), NO_PINCODE, ipStats, rules);
    expect(result.triggeredSignals).toContain("order_velocity");
    expect(result.score).toBe(18);
  });

  it("triggers when customer has >= 2 orders in last 24h", () => {
    const result = scoreOrder(
      order(),
      history({ recentOrderCount: 2 }),
      NO_PINCODE,
      NO_IP,
      rules
    );
    expect(result.triggeredSignals).toContain("order_velocity");
  });

  it("does NOT trigger for 2 IP orders (below threshold of 3)", () => {
    const ipStats: IpStats = { orderCount: 2, flagCount: 0 };
    const result = scoreOrder(order(), history(), NO_PINCODE, ipStats, rules);
    expect(result.triggeredSignals).not.toContain("order_velocity");
    expect(result.score).toBe(0);
  });

  it("does NOT trigger with 1 recent customer order", () => {
    const result = scoreOrder(
      order(),
      history({ recentOrderCount: 1 }),
      NO_PINCODE,
      NO_IP,
      rules
    );
    expect(result.triggeredSignals).not.toContain("order_velocity");
  });
});

// ─── Score / level / action calculations ─────────────────────────────────────

describe("score → level → action mapping", () => {
  it("safe: score < 30 → approve", () => {
    // Only night_order (3pts) triggered
    const result = scoreOrder(
      order({ createdAt: "2024-06-15T18:00:00.000Z" }),
      history(), NO_PINCODE, NO_IP,
      { ...DEFAULT_RULES, newCustomer: false, orderVelocity: false, highRtoPincode: false, unusualQuantity: false, incompleteAddress: false, pastRtoHistory: false, multipleAddresses: false }
    );
    expect(result.level).toBe("safe");
    expect(result.action).toBe("approve");
    expect(result.score).toBeLessThan(30);
  });

  it("medium: score 30–59 → review", () => {
    // new_customer (12) + multiple_addresses (10) + unusual_quantity (8) = 30
    const result = scoreOrder(
      order({ customer: null, lineItems: [{ quantity: 6 }] }),
      history({ totalOrders: 0, uniqueAddresses: 4 }),
      NO_PINCODE, NO_IP,
      { ...DEFAULT_RULES, highRtoPincode: false, nightOrder: false, incompleteAddress: false, pastRtoHistory: false, orderVelocity: false }
    );
    expect(result.level).toBe("medium");
    expect(result.action).toBe("review");
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(60);
  });

  it("high: score >= 60 → cancel when above autoCancelThreshold", () => {
    // past_rto (25) + high_rto_pincode (20) + order_velocity (18) = 63
    const ipStats: IpStats = { orderCount: 4, flagCount: 1 };
    const pincodeStats: PincodeStats = { totalOrders: 10, rtoCount: 5, rtoRate: 0.5 };
    const result = scoreOrder(
      order(),
      history({ rtoCount: 1 }),
      pincodeStats,
      ipStats,
      { ...DEFAULT_RULES, newCustomer: false, unusualQuantity: false, nightOrder: false, incompleteAddress: false, multipleAddresses: false, autoCancelThreshold: 60 }
    );
    expect(result.level).toBe("high");
    expect(result.action).toBe("cancel");
    expect(result.score).toBeGreaterThanOrEqual(60);
  });

  it("score is capped at 100 even when all signals fire", () => {
    // All 8 signals triggered: 12+20+8+3+4+25+10+18 = 100
    const ipStats: IpStats = { orderCount: 5, flagCount: 2 };
    const pincodeStats: PincodeStats = { totalOrders: 10, rtoCount: 5, rtoRate: 0.5 };
    const result = scoreOrder(
      order({
        customer: null,                                  // new_customer
        lineItems: [{ quantity: 8 }],                   // unusual_quantity
        createdAt: "2024-06-15T18:00:00.000Z",          // night_order
        shippingAddress: { address1: "x", city: "", zip: "123", phone: null }, // incomplete_address
      }),
      history({ rtoCount: 2, totalOrders: 0, uniqueAddresses: 5, recentOrderCount: 3 }),
      pincodeStats,
      ipStats,
      DEFAULT_RULES
    );
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.triggeredSignals.length).toBe(8);
  });
});

// ─── Weight customisation ─────────────────────────────────────────────────────

describe("custom signal weights", () => {
  it("respects a custom weight for a signal", () => {
    const rules: RulesConfig = {
      ...DEFAULT_RULES,
      newCustomer: true,
      highRtoPincode: false,
      unusualQuantity: false,
      nightOrder: false,
      incompleteAddress: false,
      pastRtoHistory: false,
      multipleAddresses: false,
      orderVelocity: false,
      newCustomerWeight: 30, // overridden from 12 → 30
    };
    const result = scoreOrder(
      order({ customer: null }),
      history({ totalOrders: 0 }),
      NO_PINCODE, NO_IP, rules
    );
    expect(result.score).toBe(30);
    expect(result.level).toBe("medium");
  });

  it("disabled signal contributes 0 regardless of its weight", () => {
    const rules: RulesConfig = {
      ...DEFAULT_RULES,
      pastRtoHistory: false,
      pastRtoHistoryWeight: 99,
    };
    const result = scoreOrder(order(), history({ rtoCount: 5 }), NO_PINCODE, NO_IP, rules);
    expect(result.triggeredSignals).not.toContain("past_rto_history");
    // Score only from other triggered signals, not 99
    expect(result.score).toBeLessThan(50);
  });
});

// ─── autoCancelThreshold ──────────────────────────────────────────────────────

describe("autoCancelThreshold", () => {
  it("action = cancel when score >= autoCancelThreshold", () => {
    const ipStats: IpStats = { orderCount: 5, flagCount: 0 };
    const result = scoreOrder(
      order(),
      history({ rtoCount: 1 }),
      NO_PINCODE, ipStats,
      { ...DEFAULT_RULES, autoCancelThreshold: 40 }
    );
    // past_rto (25) + order_velocity (18) = 43 >= 40
    expect(result.action).toBe("cancel");
  });

  it("action = review when score is in medium range but below autoCancelThreshold", () => {
    const ipStats: IpStats = { orderCount: 3, flagCount: 0 };
    const result = scoreOrder(
      order(),
      history({ rtoCount: 1 }),
      NO_PINCODE, ipStats,
      // past_rto(25) + order_velocity(18) = 43 → medium → review, not cancel (threshold=99)
      { ...DEFAULT_RULES, autoCancelThreshold: 99, newCustomer: false, highRtoPincode: false, unusualQuantity: false, nightOrder: false, incompleteAddress: false, multipleAddresses: false }
    );
    expect(result.score).toBe(43);
    expect(result.level).toBe("medium");
    expect(result.action).toBe("review");
  });
});

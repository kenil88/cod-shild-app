import prisma from "./db.server";

export interface OrderPayload {
  id: number;
  order_number: number;
  payment_gateway: string;
  total_price: string;
  browser_ip: string | null;
  client_details?: { browser_ip?: string | null };
  customer?: {
    id: number;
    phone?: string | null;
    orders_count?: number;
  } | null;
  shipping_address?: {
    address1?: string;
    city?: string;
    province?: string;
    phone?: string | null;
  } | null;
}

export interface RiskResult {
  score: number;
  level: "low" | "medium" | "high";
  recommendation: string;
}

const COD_GATEWAYS = ["cash on delivery", "cod", "manual", "pay on delivery"];

function isCOD(gateway: string): boolean {
  return COD_GATEWAYS.some((g) => gateway.toLowerCase().includes(g));
}

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.replace(/\D/g, "").slice(-10);
}

function normalizeAddress(addr: OrderPayload["shipping_address"]): string | null {
  if (!addr?.address1) return null;
  return `${addr.address1}|${addr.city}|${addr.province}`.toLowerCase().trim();
}

export async function scoreOrder(
  payload: OrderPayload,
  thresholds = { high: 70, med: 40 }
): Promise<RiskResult> {
  let score = 0;
  const reasons: string[] = [];

  // COD base score
  if (isCOD(payload.payment_gateway)) {
    score += 10;
    reasons.push("COD payment");
  } else {
    // Prepaid orders are almost never RTO — return low immediately
    return { score: 5, level: "low", recommendation: "Prepaid order — allow" };
  }

  // Check past RTO customer by phone
  const phone =
    normalizePhone(payload.customer?.phone) ??
    normalizePhone(payload.shipping_address?.phone);

  if (phone) {
    const customer = await prisma.customer.findUnique({
      where: { id: String(payload.customer?.id ?? phone) },
    });
    if (customer?.pastRTO) {
      score += 40;
      reasons.push("past RTO customer");
    }

    // Also check by phone in address table
    const flaggedAddress = await prisma.address.findFirst({
      where: { phone },
    });
    if (flaggedAddress) {
      score += 20;
      reasons.push("phone linked to flagged address");
    }
  }

  // Check flagged address
  const addrKey = normalizeAddress(payload.shipping_address);
  if (addrKey) {
    const flaggedAddr = await prisma.address.findFirst({
      where: { address: addrKey },
    });
    if (flaggedAddr) {
      score += 30;
      reasons.push("flagged delivery address");
    }
  }

  // Check IP reputation
  const ip =
    payload.browser_ip ?? payload.client_details?.browser_ip ?? null;
  if (ip && ip !== "0.0.0.0") {
    const ipCount = await prisma.iPLog.count({ where: { ip } });
    if (ipCount >= 3) {
      score += 20;
      reasons.push(`IP flagged ${ipCount} times`);
    } else if (ipCount >= 1) {
      score += 10;
      reasons.push("IP seen in previous orders");
    }
    // Log this IP
    await prisma.iPLog.create({ data: { ip } });
  }

  // First-time customer
  const ordersCount = payload.customer?.orders_count ?? 0;
  if (ordersCount <= 1) {
    score += 15;
    reasons.push("first-time customer");
  }

  // High order value (> ₹2000)
  const orderValue = parseFloat(payload.total_price ?? "0");
  if (orderValue > 2000) {
    score += 5;
    reasons.push("high order value");
  }

  score = Math.min(score, 100);

  const level: RiskResult["level"] =
    score >= thresholds.high ? "high" : score >= thresholds.med ? "medium" : "low";

  const recommendation =
    level === "high"
      ? `Block COD — ${reasons.join(", ")}`
      : level === "medium"
        ? `Review manually — ${reasons.join(", ")}`
        : reasons.length
          ? `Allow COD — ${reasons.join(", ")}`
          : "Allow COD";

  return { score, level, recommendation };
}

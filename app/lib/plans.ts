export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    limit: 50,   // orders / month; -1 = unlimited
  },
  starter: {
    name: "Starter",
    price: 7,
    limit: 500,
  },
  growth: {
    name: "Growth",
    price: 14,
    limit: 2000,
  },
  scale: {
    name: "Scale",
    price: 29,
    limit: -1,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

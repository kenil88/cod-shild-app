-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "shopifySubscriptionId" TEXT,
    "ordersThisMonth" INTEGER NOT NULL DEFAULT 0,
    "cycleStartAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_shopDomain_key" ON "subscriptions"("shopDomain");

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopName" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "pincode" TEXT,
    "ip" TEXT,
    "orderValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'safe',
    "action" TEXT NOT NULL DEFAULT 'approve',
    "signalsTriggered" JSONB NOT NULL DEFAULT '[]',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "rtoConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pincodes" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "rtoCount" INTEGER NOT NULL DEFAULT 0,
    "rtoRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pincodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rules" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "newCustomer" BOOLEAN NOT NULL DEFAULT true,
    "highRtoPincode" BOOLEAN NOT NULL DEFAULT true,
    "unusualQuantity" BOOLEAN NOT NULL DEFAULT true,
    "nightOrder" BOOLEAN NOT NULL DEFAULT true,
    "incompleteAddress" BOOLEAN NOT NULL DEFAULT true,
    "pastRtoHistory" BOOLEAN NOT NULL DEFAULT true,
    "multipleAddresses" BOOLEAN NOT NULL DEFAULT true,
    "orderVelocity" BOOLEAN NOT NULL DEFAULT true,
    "newCustomerWeight" INTEGER NOT NULL DEFAULT 12,
    "highRtoPincodeWeight" INTEGER NOT NULL DEFAULT 20,
    "unusualQuantityWeight" INTEGER NOT NULL DEFAULT 8,
    "nightOrderWeight" INTEGER NOT NULL DEFAULT 3,
    "incompleteAddressWeight" INTEGER NOT NULL DEFAULT 4,
    "pastRtoHistoryWeight" INTEGER NOT NULL DEFAULT 25,
    "multipleAddressesWeight" INTEGER NOT NULL DEFAULT 10,
    "orderVelocityWeight" INTEGER NOT NULL DEFAULT 18,
    "autoCancelThreshold" INTEGER NOT NULL DEFAULT 75,
    "autoCancel" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "savings" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderValue" DOUBLE PRECISION NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "savings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_stats" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 1,
    "flagCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_shopDomain_key" ON "merchants"("shopDomain");

-- CreateIndex
CREATE INDEX "orders_shopDomain_createdAt_idx" ON "orders"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "orders_shopDomain_phone_idx" ON "orders"("shopDomain", "phone");

-- CreateIndex
CREATE INDEX "pincodes_shopDomain_rtoRate_idx" ON "pincodes"("shopDomain", "rtoRate");

-- CreateIndex
CREATE UNIQUE INDEX "pincodes_shopDomain_pincode_key" ON "pincodes"("shopDomain", "pincode");

-- CreateIndex
CREATE UNIQUE INDEX "rules_shopDomain_key" ON "rules"("shopDomain");

-- CreateIndex
CREATE INDEX "savings_shopDomain_savedAt_idx" ON "savings"("shopDomain", "savedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ip_stats_shopDomain_ip_key" ON "ip_stats"("shopDomain", "ip");

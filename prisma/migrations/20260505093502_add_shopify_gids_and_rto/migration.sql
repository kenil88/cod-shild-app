-- AlterTable
ALTER TABLE "OrderRisk" ADD COLUMN     "rtoConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopifyCustomerGid" TEXT,
ADD COLUMN     "shopifyOrderGid" TEXT;

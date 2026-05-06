CREATE TABLE "webhook_jobs" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_jobs_status_createdAt_idx" ON "webhook_jobs"("status", "createdAt");
CREATE INDEX "webhook_jobs_shopDomain_createdAt_idx" ON "webhook_jobs"("shopDomain", "createdAt");

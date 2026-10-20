-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "retryAfter" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_retryAfter_idx" ON "OutboxEvent"("publishedAt", "retryAfter");

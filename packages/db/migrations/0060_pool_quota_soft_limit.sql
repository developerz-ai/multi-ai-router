-- quotaSoftLimit: universal per-pool soft utilization limit applied by routing selection
-- regardless of routing policy. Accounts at or above it rank last / are dropped as
-- soft-limited (clock-recoverable at reset). Existing key state, model assignments,
-- key scope, and RouterSpendLimitNear alert threshold unchanged. Default 0.8 so no
-- pool changes behavior until an operator sets a value lower.
ALTER TABLE "pools" ADD COLUMN IF NOT EXISTS "quota_soft_limit" numeric(3,2) DEFAULT '0.80';

-- ============================================================================
-- BTECH SMM — Order delivery-progress tracking (customer-facing)
-- ----------------------------------------------------------------------------
-- Run after migration_delix_provider.sql. Additive/idempotent.
--
-- Adds ONE column: orders.provider_remains, the last known "units still to
-- deliver" count from Delix's status API (its "remains" field). Everything
-- else this feature needs — orders.provider_status, orders.provider_order_id,
-- orders.provider_synced_at, orders.status/quantity — already exists.
--
-- No RLS change: "orders_select_own" (schema.sql) already lets a customer
-- read their own order row, including this new column, exactly like today.
-- Nothing here is admin-only, unlike every other provider column, because
-- customers are meant to see their own delivery progress.
-- ============================================================================

alter table public.orders
  add column if not exists provider_remains integer;

-- ============================================================================
-- End of migration.
-- ============================================================================

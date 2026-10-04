-- ============================================================================
-- BTECH SMM — Delix Gains provider integration (Phase 3A/3B/3C)
-- ----------------------------------------------------------------------------
-- Run after all previous migrations. Additive/idempotent.
--
-- Reuses the EXISTING `providers` and `provider_services` tables from
-- schema.sql rather than creating new ones — they were already exactly the
-- right shape for this (provider record + per-service provider mapping),
-- just missing a few metadata columns and any seeded row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- providers: seed the Delix Gains row (idempotent on name)
-- ---------------------------------------------------------------------------
insert into public.providers (name, api_base_url, active)
select 'Delix Gains', 'https://delixgainske.com/api/v2', true
where not exists (select 1 from public.providers where name = 'Delix Gains');

-- ---------------------------------------------------------------------------
-- provider_services: add the metadata columns the sync step needs.
-- provider_service_ref (already existed) stores Delix's numeric service id.
-- ---------------------------------------------------------------------------
alter table public.provider_services
  add column if not exists provider_name text,
  add column if not exists provider_type text,
  add column if not exists provider_category text,
  add column if not exists provider_rate numeric,
  add column if not exists provider_currency text,
  add column if not exists provider_min integer,
  add column if not exists provider_max integer,
  add column if not exists provider_refill boolean,
  add column if not exists provider_cancel boolean,
  add column if not exists last_provider_sync timestamptz;

-- One BTECH service should map to at most one row per provider.
create unique index if not exists provider_services_unique_mapping
  on public.provider_services (provider_id, service_id);

-- ---------------------------------------------------------------------------
-- orders: provider fulfilment fields. Deliberately NOT touching the
-- `status` check constraint — BTECH's own pending/processing/completed/
-- cancelled lifecycle stays as-is (see migration notes / report). Provider
-- status is tracked separately as free text, exactly as the brief asked.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists provider text,
  add column if not exists provider_order_id text,
  add column if not exists provider_status text,
  add column if not exists provider_synced_at timestamptz;

-- Prevents ever accidentally double-submitting the same BTECH order to a
-- provider — enforced at the database level, not just in application code.
create unique index if not exists orders_one_provider_order
  on public.orders (provider, provider_order_id)
  where provider_order_id is not null;

-- ============================================================================
-- End of migration.
-- ============================================================================

-- ============================================================================
-- BTECH SMM — Restrict payment RPC execute permissions
-- ----------------------------------------------------------------------------
-- Run after migration_mpesa_daraja.sql. Additive, does not change behavior
-- for the Edge Function (which calls these via the service-role client and
-- is unaffected by this) — only removes a capability that should never have
-- existed: any logged-in customer's browser session calling these directly.
--
-- WHY THIS MATTERS: Postgres grants EXECUTE on newly created functions to
-- PUBLIC by default unless explicitly revoked. Neither of these two new
-- `security definer` functions had that default revoked, so — despite each
-- one independently re-verifying `payments.status = 'paid'` before doing
-- anything, and despite always crediting the payment's own recorded
-- user_id rather than the caller's — a customer could still call
-- `supabase.rpc('credit_wallet_from_payment', {...})` directly from
-- devtools today. It wouldn't let them steal funds (the function ignores
-- who's calling and always pays the payment's actual owner), but it's
-- capability a browser session should never have needed in the first
-- place. This closes that gap.
-- ============================================================================

revoke execute on function public.credit_wallet_from_payment(uuid) from public, anon, authenticated;
grant execute on function public.credit_wallet_from_payment(uuid) to service_role;

revoke execute on function public.mark_order_paid_from_payment(uuid) from public, anon, authenticated;
grant execute on function public.mark_order_paid_from_payment(uuid) to service_role;

-- ============================================================================
-- End of migration.
--
-- Broader note, not acted on here per "smallest safe change": every other
-- security-definer function in this project (place_order,
-- request_order_cancellation, review_refund_request, is_admin, etc.) has
-- the same PUBLIC-execute default. Each of those already independently
-- checks the condition that actually matters (ownership via auth.uid(),
-- or is_admin()) before doing anything sensitive, so none of them are
-- exploitable today — but the same REVOKE/GRANT pattern above would be the
-- correct defense-in-depth cleanup for all of them in a future pass.
-- ============================================================================

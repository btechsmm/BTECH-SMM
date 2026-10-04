/**
 * BTECH SMM — Supabase Module (CONNECTED — Phase 4)
 * ----------------------------------------------------------------
 * Loads the Supabase JS client from a CDN (no build step, so this
 * uses an ESM URL import rather than an npm package) and exports a
 * single configured client used by every other data module.
 *
 * SECURITY NOTES:
 *   - SUPABASE_ANON_KEY below is the PUBLIC "publishable" key. It is
 *     designed to be shipped in frontend code and is safe here —
 *     access control is enforced by the Row Level Security (RLS)
 *     policies defined in supabase/schema.sql, not by keeping this
 *     key secret.
 *   - The service-role key must NEVER be placed in this file or any
 *     other frontend script. It does not appear anywhere in this
 *     codebase and never should.
 *   - Run supabase/schema.sql once in the Supabase SQL Editor before
 *     using this app — it creates every table, RLS policy and
 *     trigger this module and the rest of the app depend on.
 */

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://nbiigfncyzfuzciubmru.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_pGz0wroXcNBBv92OTB_dOA_BJuTl_bP";

export const SUPABASE_READY = true;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export function getSupabaseClient() {
  return supabase;
}

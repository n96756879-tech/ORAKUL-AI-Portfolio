create table if not exists public.free_generation_ledger (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  reserved_at timestamptz not null default now(),
  consumed boolean not null default false
);

create unique index if not exists idx_free_gen_fingerprint_unconsumed
  on public.free_generation_ledger (fingerprint)
  where consumed = false;

create unique index if not exists idx_free_gen_fingerprint_global
  on public.free_generation_ledger (fingerprint);

alter table public.free_generation_ledger enable row level security;

-- SECURITY: anon and authenticated roles must NEVER be able to read or write the ledger directly.
-- All access is server-only via SUPABASE_SERVICE_ROLE_KEY (service_role).
-- The public anon key is not a secret and must not grant any access to this table.

create policy "service_role_all" on public.free_generation_ledger
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Deny by default for anon/authenticated (defense in depth)
create policy "anon_deny_all" on public.free_generation_ledger
  for all
  using (false)
  with check (false);

-- Explicit grants (apply after migration)
-- REVOKE ALL ON public.free_generation_ledger FROM anon, authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.free_generation_ledger TO service_role;

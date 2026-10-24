-- Credit ledger: balances, transactions, and atomic grant RPC.
-- All mutations are server-only via SUPABASE_SERVICE_ROLE_KEY (service_role).
-- RLS enabled on both tables. Explicit GRANT/REVOKE as defense-in-depth.

-- ── credit_balances ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.credit_balances (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance    bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_balances_non_negative CHECK (balance >= 0)
);

-- ── credit_transactions ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount          bigint      NOT NULL,
  reason          text        NOT NULL,
  reference       text        NULL,
  idempotency_key text        NOT NULL,
  created_by      uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Unique idempotency key: one credit grant per key, globally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_tx_idempotency
  ON public.credit_transactions (idempotency_key);

-- Index for listing a user's history sorted by time (newest first).
CREATE INDEX IF NOT EXISTS idx_credit_tx_user_time
  ON public.credit_transactions (user_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────

ALTER TABLE public.credit_balances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

-- Idempotent policy creation: drop first, then create with identical semantics.

-- Users can read only their own balance.
DROP POLICY IF EXISTS credit_balances_select_own ON public.credit_balances;
CREATE POLICY credit_balances_select_own
  ON public.credit_balances
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can read only their own transactions.
DROP POLICY IF EXISTS credit_transactions_select_own ON public.credit_transactions;
CREATE POLICY credit_transactions_select_own
  ON public.credit_transactions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- service_role gets full access (bypasses RLS, but policies are explicit).
DROP POLICY IF EXISTS credit_balances_service_all ON public.credit_balances;
CREATE POLICY credit_balances_service_all
  ON public.credit_balances
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS credit_transactions_service_all ON public.credit_transactions;
CREATE POLICY credit_transactions_service_all
  ON public.credit_transactions
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ── GRANT / REVOKE (defense-in-depth) ────────────────────────────

-- Revoke all from anon and authenticated on both tables.
REVOKE ALL ON public.credit_balances     FROM anon, authenticated;
REVOKE ALL ON public.credit_transactions FROM anon, authenticated;

-- Grant only SELECT to authenticated (own rows, enforced by RLS).
GRANT SELECT ON public.credit_balances     TO authenticated;
GRANT SELECT ON public.credit_transactions TO authenticated;

-- service_role gets full access.
GRANT ALL ON public.credit_balances     TO service_role;
GRANT ALL ON public.credit_transactions TO service_role;

-- ── Atomic grant RPC ─────────────────────────────────────────────
-- SECURITY DEFINER: runs with the function owner's privileges (superuser
-- during migration), not the caller's.  EXECUTE is revoked from PUBLIC
-- and granted only to service_role, so anon/authenticated cannot call it.

CREATE OR REPLACE FUNCTION public.grant_credits(
  p_user_id        uuid,
  p_amount         bigint,
  p_reason         text,
  p_created_by     uuid,
  p_idempotency_key text
)
RETURNS TABLE (
  new_balance   bigint,
  transaction_id uuid,
  is_duplicate  boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_tx  uuid;
  v_existing_amt uuid;
  v_new_balance  bigint;
  v_reason       text;
  v_tx_id        uuid;
BEGIN
  -- ── Validate inputs ───────────────────────────────────────────
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '23502';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be a positive integer' USING ERRCODE = '23514';
  END IF;

  IF p_amount > 100000 THEN
    RAISE EXCEPTION 'amount exceeds maximum (100000)' USING ERRCODE = '23514';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reason is required' USING ERRCODE = '23502';
  END IF;

  IF length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'reason too long (max 500)' USING ERRCODE = '22001';
  END IF;

  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = '23502';
  END IF;

  -- ── Verify target user exists in auth.users ───────────────────
  PERFORM 1 FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
  END IF;

  -- ── Atomic idempotent insert ────────────────────────────────────
  -- Try to insert; on conflict (duplicate key), do nothing and inspect existing row.
  INSERT INTO public.credit_transactions (user_id, amount, reason, idempotency_key, created_by)
    VALUES (p_user_id, p_amount, btrim(p_reason), p_idempotency_key, p_created_by)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- Key already exists. Verify parameters match exactly.
    SELECT id, user_id, amount, reason
      INTO v_existing_tx, v_existing_amt, v_new_balance, v_reason
      FROM public.credit_transactions
      WHERE idempotency_key = p_idempotency_key
      LIMIT 1;

    IF v_existing_amt != p_user_id OR v_new_balance != p_amount OR v_reason != btrim(p_reason) THEN
      RAISE EXCEPTION 'idempotency key conflict: same key with different parameters' USING ERRCODE = '40901';
    END IF;

    -- Return original result without re-crediting.
    SELECT balance INTO v_new_balance
      FROM public.credit_balances
      WHERE user_id = v_existing_amt;

    RETURN QUERY SELECT v_new_balance, v_existing_tx, true;
    RETURN;
  END IF;

  -- New transaction inserted. Upsert balance atomically in same transaction.
  INSERT INTO public.credit_balances (user_id, balance, updated_at)
    VALUES (p_user_id, p_amount, now())
    ON CONFLICT (user_id)
    DO UPDATE SET
      balance    = credit_balances.balance + p_amount,
      updated_at = now()
    RETURNING balance INTO v_new_balance;

  RETURN QUERY SELECT v_new_balance, v_tx_id, false;
END;
$$;

-- Revoke EXECUTE from PUBLIC and anon/authenticated; grant only to service_role.
REVOKE EXECUTE ON FUNCTION public.grant_credits FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credits TO service_role;

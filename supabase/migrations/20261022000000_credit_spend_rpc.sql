-- Credit spend lifecycle (reserve/consume/release) for ANALYSIS_COST.
-- Additive migration. Does not alter grant_credits or prior ledger tables.
-- All mutations server-only via service_role. RLS + explicit grants as defense-in-depth.
-- Compatible with 20261018000000_credit_ledger.sql (reuses credit_balances and credit_transactions patterns).

-- ── credit_spend_reservations (lifecycle state for spend operations) ─────

CREATE TABLE IF NOT EXISTS public.credit_spend_reservations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount           bigint      NOT NULL CHECK (amount > 0),
  reason           text        NOT NULL,
  idempotency_key  text        NOT NULL,
  status           text        NOT NULL DEFAULT 'reserved'
                   CHECK (status IN ('reserved', 'consumed', 'released')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Unique idempotency per spend operation (prevents replay/double).
CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_spend_res_idem
  ON public.credit_spend_reservations (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_credit_spend_res_user_time
  ON public.credit_spend_reservations (user_id, created_at DESC);

-- RLS: deny anon/auth by default; service_role full.
ALTER TABLE public.credit_spend_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_spend_res_service_all ON public.credit_spend_reservations;
CREATE POLICY credit_spend_res_service_all
  ON public.credit_spend_reservations
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.credit_spend_reservations FROM anon, authenticated;
GRANT ALL ON public.credit_spend_reservations TO service_role;

-- Optional: authenticated may SELECT their own (read-only, for UI history if needed later).
-- For now keep strict: no direct access. Service only.
-- GRANT SELECT ON public.credit_spend_reservations TO authenticated;
-- (RLS would also need a SELECT policy using auth.uid() if enabled.)

-- ── RPC: reserve_credit_spend ─────────────────────────────────────────────
-- Atomically: verify user, check balance >= amount, deduct, create 'reserved' row.
-- Idempotent on key: same key+params returns prior result without double deduct.
-- Returns: reservation_id, balance_after (after deduct), is_duplicate.

CREATE OR REPLACE FUNCTION public.reserve_credit_spend(
  p_user_id        uuid,
  p_amount         bigint,
  p_reason         text,
  p_idempotency_key text
)
RETURNS TABLE (
  reservation_id  uuid,
  balance_after   bigint,
  is_duplicate    boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id   uuid;
  v_existing_amt  bigint;
  v_existing_user uuid;
  v_existing_reason text;
  v_existing_status text;
  v_new_balance   bigint;
  v_res_id        uuid;
BEGIN
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

  -- Verify user exists
  PERFORM 1 FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target user not found' USING ERRCODE = 'P0002';
  END IF;

  -- Serialize every call that shares an idempotency key. Transaction-scoped advisory
  -- lock is what makes "look up existing -> insert" atomic: the loser of a race blocks
  -- here and then reads the winner's committed row instead of hitting the unique index.
  PERFORM pg_advisory_xact_lock(hashtextextended('credit_spend_reserve:' || p_idempotency_key, 0));

  -- Idempotency: existing key?
  SELECT id, user_id, amount, reason, status
    INTO v_existing_id, v_existing_user, v_existing_amt, v_existing_reason, v_existing_status
    FROM public.credit_spend_reservations
    WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Must match exactly (user, amount, reason)
    IF v_existing_user != p_user_id OR v_existing_amt != p_amount OR btrim(v_existing_reason) != btrim(p_reason) THEN
      RAISE EXCEPTION 'idempotency key conflict: same key with different parameters' USING ERRCODE = '40901';
    END IF;
    -- A released reservation was refunded: its key is spent and must never look like a
    -- successful reservation. The caller has to retry with a new operation id.
    IF v_existing_status = 'released' THEN
      RAISE EXCEPTION 'idempotency key conflict: reservation was released, a new operation id is required' USING ERRCODE = '40901';
    END IF;
    -- 'reserved' or 'consumed': the balance was already deducted exactly once by the first call.
    SELECT balance INTO v_new_balance FROM public.credit_balances WHERE user_id = v_existing_user;
    RETURN QUERY SELECT v_existing_id, COALESCE(v_new_balance, 0), true;
    RETURN;
  END IF;

  -- Create the reservation BEFORE deducting so a unique-index race can be absorbed by
  -- the handler below without ever having deducted the balance twice.
  BEGIN
    INSERT INTO public.credit_spend_reservations (user_id, amount, reason, idempotency_key, status)
      VALUES (p_user_id, p_amount, btrim(p_reason), p_idempotency_key, 'reserved')
      RETURNING id INTO v_res_id;
  EXCEPTION WHEN unique_violation THEN
    -- The advisory lock makes this unreachable in practice; kept as a hard safety net.
    SELECT id, user_id, amount, reason, status
      INTO v_existing_id, v_existing_user, v_existing_amt, v_existing_reason, v_existing_status
      FROM public.credit_spend_reservations
      WHERE idempotency_key = p_idempotency_key;
    IF NOT FOUND
       OR v_existing_user != p_user_id
       OR v_existing_amt != p_amount
       OR btrim(v_existing_reason) != btrim(p_reason)
       OR v_existing_status = 'released' THEN
      RAISE EXCEPTION 'idempotency key conflict: concurrent reservation with different parameters' USING ERRCODE = '40901';
    END IF;
    SELECT balance INTO v_new_balance FROM public.credit_balances WHERE user_id = v_existing_user;
    RETURN QUERY SELECT v_existing_id, COALESCE(v_new_balance, 0), true;
    RETURN;
  END;

  -- Check current balance under lock to prevent races (atomic check+deduct).
  SELECT balance INTO v_new_balance
    FROM public.credit_balances
    WHERE user_id = p_user_id
    FOR UPDATE;

  IF NOT FOUND OR v_new_balance IS NULL THEN
    v_new_balance := 0;
  END IF;

  IF v_new_balance < p_amount THEN
    -- Rolls the reservation insert back too: no half-created spend without a deduction.
    RAISE EXCEPTION 'insufficient balance' USING ERRCODE = '23514';
  END IF;

  -- Deduct now (reserve is the point of balance change).
  UPDATE public.credit_balances
    SET balance = balance - p_amount,
        updated_at = now()
    WHERE user_id = p_user_id
    RETURNING balance INTO v_new_balance;

  -- Also log a transaction row for audit (negative amount for spend reserve).
  -- credit_transactions.idempotency_key is globally UNIQUE, so the ledger key is derived
  -- from the reservation id: exactly one deduction tx per reservation, no collision with
  -- the release refund tx ('release:<id>') nor with a grant that reuses the caller key.
  INSERT INTO public.credit_transactions (user_id, amount, reason, reference, idempotency_key, created_by)
    VALUES (p_user_id, -p_amount, btrim(p_reason), 'credit_spend_reserve:' || v_res_id::text, 'reserve:' || v_res_id::text, NULL);

  RETURN QUERY SELECT v_res_id, v_new_balance, false;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_credit_spend FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_credit_spend TO service_role;

-- ── RPC: consume_credit_spend ─────────────────────────────────────────────
-- Mark a reserved operation as consumed (final). Idempotent.
-- No balance change (already deducted on reserve).

CREATE OR REPLACE FUNCTION public.consume_credit_spend(
  p_reservation_id uuid,
  p_idempotency_key text
)
RETURNS TABLE ( success boolean )
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_idem   text;
BEGIN
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'reservation_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT status, idempotency_key INTO v_status, v_idem
    FROM public.credit_spend_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = '22000';
  END IF;

  -- If called with a key, it must match when provided.
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' AND v_idem <> p_idempotency_key THEN
    RAISE EXCEPTION 'idempotency key mismatch' USING ERRCODE = '40901';
  END IF;

  IF v_status = 'consumed' THEN
    RETURN QUERY SELECT true;
    RETURN;
  END IF;
  IF v_status = 'released' THEN
    RAISE EXCEPTION 'cannot consume a released reservation' USING ERRCODE = '23514';
  END IF;

  UPDATE public.credit_spend_reservations
    SET status = 'consumed', updated_at = now()
    WHERE id = p_reservation_id;

  RETURN QUERY SELECT true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_credit_spend FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_credit_spend TO service_role;

-- ── RPC: release_credit_spend ─────────────────────────────────────────────
-- Release a reserved spend (refund). Idempotent. Cannot release twice or after consume.

CREATE OR REPLACE FUNCTION public.release_credit_spend(
  p_reservation_id uuid,
  p_idempotency_key text
)
RETURNS TABLE ( released boolean, refunded_amount bigint )
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_amt    bigint;
  v_user   uuid;
  v_idem   text;
  v_new_bal bigint;
BEGIN
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'reservation_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT status, amount, user_id, idempotency_key
    INTO v_status, v_amt, v_user, v_idem
    FROM public.credit_spend_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = '22000';
  END IF;

  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' AND v_idem <> p_idempotency_key THEN
    RAISE EXCEPTION 'idempotency key mismatch' USING ERRCODE = '40901';
  END IF;

  IF v_status = 'released' THEN
    RETURN QUERY SELECT true, 0::bigint;
    RETURN;
  END IF;
  IF v_status = 'consumed' THEN
    RAISE EXCEPTION 'cannot release a consumed reservation' USING ERRCODE = '23514';
  END IF;

  -- Refund
  INSERT INTO public.credit_balances (user_id, balance, updated_at)
    VALUES (v_user, v_amt, now())
    ON CONFLICT (user_id)
    DO UPDATE SET balance = credit_balances.balance + v_amt, updated_at = now()
    RETURNING balance INTO v_new_bal;

  UPDATE public.credit_spend_reservations
    SET status = 'released', updated_at = now()
    WHERE id = p_reservation_id;

  -- Log refund as positive adjustment tx (reference to original reserve).
  -- The tx idempotency key must differ from the reservation key written by
  -- reserve_credit_spend (credit_transactions.idempotency_key is UNIQUE).
  -- No ON CONFLICT here: swallowing a key collision would refund the balance and
  -- release the reservation while leaving no matching ledger row. A collision means
  -- the ledger and the reservation disagree, so it must abort the whole call: the
  -- refund, the status flip and the journal row are one transaction and fail together.
  INSERT INTO public.credit_transactions (user_id, amount, reason, reference, idempotency_key, created_by)
    VALUES (v_user, v_amt, 'credit_spend_release', 'credit_spend_release:' || p_reservation_id::text, 'release:' || p_reservation_id::text, NULL);

  RETURN QUERY SELECT true, v_amt;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_credit_spend FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_credit_spend TO service_role;

-- End of migration.

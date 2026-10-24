-- Prediction history per account (football-only product).
-- Additive migration. Does not alter credit tables, RPCs or the free-generation ledger.
-- Writes are server-only via service_role; authenticated users may only SELECT their own rows.
-- Follows the RLS/grant conventions of 20261018000000_credit_ledger.sql.

-- ── predictions ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.predictions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sport           text        NOT NULL DEFAULT 'football',
  match_title     text        NOT NULL,
  payload         jsonb       NOT NULL,
  idempotency_key text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT predictions_sport_football_only CHECK (sport = 'football')
);

-- One history row per logical analysis operation; a replay must not create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_idempotency
  ON public.predictions (idempotency_key);

-- Listing a user's history newest-first.
CREATE INDEX IF NOT EXISTS idx_predictions_user_time
  ON public.predictions (user_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;

-- Idempotent policy creation: drop first, then create with identical semantics.

-- Users can read only their own predictions.
DROP POLICY IF EXISTS predictions_select_own ON public.predictions;
CREATE POLICY predictions_select_own
  ON public.predictions
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- service_role performs all writes/reads (server-only).
DROP POLICY IF EXISTS predictions_service_all ON public.predictions;
CREATE POLICY predictions_service_all
  ON public.predictions
  FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ── GRANT / REVOKE (defense-in-depth) ────────────────────────────────────

-- No client-side writes or mutations of history.
REVOKE ALL ON public.predictions FROM anon, authenticated;
GRANT SELECT ON public.predictions TO authenticated;
GRANT ALL ON public.predictions TO service_role;

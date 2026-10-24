import type { SupabaseClient } from '@supabase/supabase-js';

// ── Prediction history (football-only) ────────────────────────────────────
// Rows are written exclusively by the server (service_role) after a confirmed
// credit spend. Reading is available to authenticated users via RLS, but every
// server-side read still filters by user_id explicitly (RLS is not the only guard).

export type PredictionPayload = Record<string, unknown>;

export type SavePredictionInput = {
  userId: string;
  sport?: 'football';
  matchTitle: string;
  payload: PredictionPayload;
  idempotencyKey: string;
};

export type SavePredictionResult =
  | { ok: true; id: string; isDuplicate: boolean }
  | { ok: false; error: string; status: number };

export type PredictionRow = {
  id: string;
  user_id: string;
  sport: string;
  match_title: string;
  payload: PredictionPayload;
  idempotency_key: string;
  created_at: string;
};

export type PredictionsResult =
  | { ok: true; predictions: PredictionRow[] }
  | { ok: false; error: string; status: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export async function savePrediction(
  client: SupabaseClient,
  input: SavePredictionInput,
): Promise<SavePredictionResult> {
  const { userId, sport = 'football', matchTitle, payload, idempotencyKey } = input;

  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return { ok: false, error: 'Некорректный идентификатор пользователя.', status: 400 };
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    return { ok: false, error: 'Отсутствует ключ идемпотентности.', status: 400 };
  }

  if (typeof matchTitle !== 'string' || matchTitle.trim().length === 0) {
    return { ok: false, error: 'Отсутствует название матча.', status: 400 };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Некорректный payload прогноза.', status: 400 };
  }

  // ON CONFLICT DO NOTHING: a replayed operation keeps the existing row untouched,
  // so a conflicting key can never overwrite a different prediction.
  const { data, error } = await client
    .from('predictions')
    .upsert(
      {
        user_id: userId,
        sport,
        match_title: matchTitle.trim(),
        payload,
        idempotency_key: idempotencyKey,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id');

  if (error) {
    // Diagnostics without secrets and without the payload contents.
    console.error('[predictions] insert failed:', {
      code: error.code ?? 'unknown',
      message: error.message ?? 'unknown',
    });
    return { ok: false, error: 'Не удалось сохранить прогноз.', status: 500 };
  }

  const inserted = Array.isArray(data) ? (data[0] as { id?: string } | undefined) : undefined;
  if (inserted?.id) {
    return { ok: true, id: inserted.id, isDuplicate: false };
  }

  // Duplicate key: the row already exists. Re-read it scoped to the same user so a
  // colliding key owned by somebody else is never returned.
  const { data: existing, error: readError } = await client
    .from('predictions')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) {
    console.error('[predictions] duplicate lookup failed:', {
      code: readError.code ?? 'unknown',
      message: readError.message ?? 'unknown',
    });
    return { ok: false, error: 'Не удалось проверить сохранённый прогноз.', status: 500 };
  }

  const existingRow = existing as { id?: string } | null;
  if (existingRow?.id) {
    return { ok: true, id: existingRow.id, isDuplicate: true };
  }

  return { ok: false, error: 'Конфликт ключа идемпотентности.', status: 409 };
}

export async function listPredictions(
  client: SupabaseClient,
  userId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<PredictionsResult> {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return { ok: false, error: 'Некорректный идентификатор пользователя.', status: 400 };
  }

  const safeLimit = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), MAX_HISTORY_LIMIT)
    : DEFAULT_HISTORY_LIMIT;

  const { data, error } = await client
    .from('predictions')
    .select('id, user_id, sport, match_title, payload, idempotency_key, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    console.error('[predictions] list failed:', {
      code: error.code ?? 'unknown',
      message: error.message ?? 'unknown',
    });
    return { ok: false, error: 'Ошибка при получении истории прогнозов.', status: 500 };
  }

  return { ok: true, predictions: (data ?? []) as PredictionRow[] };
}

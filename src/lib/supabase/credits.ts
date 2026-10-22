import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_GRANT_AMOUNT, MAX_REASON_LENGTH } from '@/lib/admin/guard';

export type GrantInput = {
  userId: string;
  amount: number;
  reason: string;
  createdBy: string;
  idempotencyKey: string;
};

export type ValidationResult =
  | { ok: true; userId: string; amount: number; reason: string; idempotencyKey: string }
  | { ok: false; error: string; status: 400 };

export type GrantResult =
  | { ok: true; newBalance: number; transactionId: string; isDuplicate: boolean }
  | { ok: false; error: string; status: number };

export type BalanceResult =
  | { ok: true; balance: number; exists: boolean }
  | { ok: false; error: string; status: number };

export type TransactionRow = {
  id: string;
  user_id: string;
  amount: number;
  reason: string;
  reference: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: string;
};

export type TransactionsResult =
  | { ok: true; transactions: TransactionRow[] }
  | { ok: false; error: string; status: number };

export function validateGrantInput(raw: {
  userId?: unknown;
  amount?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}): ValidationResult {
  const { userId, amount, reason, idempotencyKey } = raw;

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return { ok: false, error: 'Не указан идентификатор пользователя.', status: 400 };
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId.trim())) {
    return { ok: false, error: 'Некорректный формат идентификатора пользователя.', status: 400 };
  }

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    return { ok: false, error: 'Отсутствует ключ идемпотентности.', status: 400 };
  }

  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    return { ok: false, error: 'Количество кредитов должно быть целым числом.', status: 400 };
  }

  if (amount <= 0) {
    return { ok: false, error: 'Количество кредитов должно быть положительным.', status: 400 };
  }

  if (amount > MAX_GRANT_AMOUNT) {
    return { ok: false, error: `Превышен лимит одного начисления (макс. ${MAX_GRANT_AMOUNT}).`, status: 400 };
  }

  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, error: 'Укажите причину начисления.', status: 400 };
  }

  if (reason.trim().length > MAX_REASON_LENGTH) {
    return { ok: false, error: `Причина слишком длинная (макс. ${MAX_REASON_LENGTH} символов).`, status: 400 };
  }

  return {
    ok: true,
    userId: userId.trim(),
    amount,
    reason: reason.trim(),
    idempotencyKey: idempotencyKey.trim(),
  };
}

export async function grantCredits(
  client: SupabaseClient,
  input: GrantInput,
): Promise<GrantResult> {
  const { data, error } = await client.rpc('grant_credits', {
    p_user_id: input.userId,
    p_amount: input.amount,
    p_reason: input.reason,
    p_created_by: input.createdBy,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error) {
    const code = error.code ?? '';
    if (code === '40901' || error.message?.includes('idempotency key conflict')) {
      return { ok: false, error: 'Ключ идемпотентности уже использован с другими параметрами.', status: 409 };
    }
    if (code === '23505' || error.message?.includes('duplicate key')) {
      return { ok: false, error: 'Повторный запрос с тем же ключом идемпотентности.', status: 409 };
    }
    if (code === 'P0002' || error.message?.includes('target user not found')) {
      return { ok: false, error: 'Пользователь не найден.', status: 404 };
    }
    return { ok: false, error: 'Ошибка базы данных при начислении.', status: 500 };
  }

  const rows = data as Array<{ new_balance: number; transaction_id: string; is_duplicate: boolean }> | null;
  const row = rows?.[0] ?? null;

  if (!row || typeof row.new_balance !== 'number' || typeof row.transaction_id !== 'string') {
    return { ok: false, error: 'Неожиданный ответ базы данных.', status: 500 };
  }

  return {
    ok: true,
    newBalance: row.new_balance,
    transactionId: row.transaction_id,
    isDuplicate: !!row.is_duplicate,
  };
}

export async function getBalance(
  client: SupabaseClient,
  userId: string,
): Promise<BalanceResult> {
  const { data, error } = await client
    .from('credit_balances')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    return { ok: false, error: 'Ошибка при получении баланса.', status: 500 };
  }

  if (!data) {
    return { ok: true, balance: 0, exists: false };
  }

  return { ok: true, balance: data.balance as number, exists: true };
}

export async function listTransactions(
  client: SupabaseClient,
  userId: string,
  limit = 50,
): Promise<TransactionsResult> {
  const { data, error } = await client
    .from('credit_transactions')
    .select('id, user_id, amount, reason, reference, idempotency_key, created_by, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return { ok: false, error: 'Ошибка при получении истории.', status: 500 };
  }

  return { ok: true, transactions: (data ?? []) as TransactionRow[] };
}

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

export type FreeLimitResult =
  | { allowed: true; reservationId: string }
  | { allowed: false; reason: 'limit_exhausted' | 'config_missing' | 'db_error' };

export type ReleaseResult =
  | { released: true; deletedCount: 1 }
  | { released: false; reason: 'not_found' }
  | { released: false; reason: 'db_error' }
  | { released: false; reason: 'unknown' }
  | { released: false; reason: 'not_configured' };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_CONFIGURED = !!SUPABASE_URL && !!SERVICE_ROLE_KEY;

function getLedgerClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;
  return createSupabaseJsClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function normalizeFingerprint(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function reserveFreeGeneration(
  rawFingerprint: string,
): Promise<FreeLimitResult> {
  if (!SUPABASE_CONFIGURED) {
    return { allowed: false, reason: 'config_missing' };
  }

  const fingerprint = normalizeFingerprint(rawFingerprint);

  const supabase = getLedgerClient();
  if (!supabase) {
    return { allowed: false, reason: 'config_missing' };
  }

  try {
    const { data, error } = await supabase
      .from('free_generation_ledger')
      .insert({ fingerprint, consumed: false })
      .select('id')
      .single();

    if (error) {
      if (
        error.code === '23505' ||
        error.message?.includes('duplicate key') ||
        error.message?.includes('unique constraint')
      ) {
        return { allowed: false, reason: 'limit_exhausted' };
      }
      console.error('[free-limit] insert error:', error);
      return { allowed: false, reason: 'db_error' };
    }

    return { allowed: true, reservationId: data.id };
  } catch (err) {
    console.error('[free-limit] unexpected error:', err);
    return { allowed: false, reason: 'db_error' };
  }
}

export async function consumeFreeGeneration(
  reservationId: string,
): Promise<{ success: boolean }> {
  if (!SUPABASE_CONFIGURED) {
    return { success: false };
  }

  const supabase = getLedgerClient();
  if (!supabase) {
    return { success: false };
  }

  try {
    const { error, count } = await supabase
      .from('free_generation_ledger')
      .update({ consumed: true }, { count: 'exact' })
      .eq('id', reservationId)
      .eq('consumed', false);

    if (error) {
      console.error('[free-limit] consume error:', error);
      return { success: false };
    }

    if (count !== 1) {
      console.error('[free-limit] consume did not affect exactly one row:', count, 'for reservation:', reservationId);
      return { success: false };
    }

    return { success: true };
  } catch (err) {
    console.error('[free-limit] consume unexpected error:', err);
    return { success: false };
  }
}

export async function releaseFreeGeneration(
  reservationId: string,
): Promise<ReleaseResult> {
  if (!SUPABASE_CONFIGURED) {
    return { released: false, reason: 'not_configured' };
  }

  const supabase = getLedgerClient();
  if (!supabase) {
    return { released: false, reason: 'not_configured' };
  }

  try {
    const { error, count } = await supabase
      .from('free_generation_ledger')
      .delete({ count: 'exact' })
      .eq('id', reservationId)
      .eq('consumed', false);

    if (error) {
      console.error('[free-limit] release error:', error);
      return { released: false, reason: 'db_error' };
    }

    if (typeof count !== 'number') {
      console.error('[free-limit] release did not return an exact count; result unknown for reservation:', reservationId);
      return { released: false, reason: 'unknown' };
    }

    if (count === 0) {
      return { released: false, reason: 'not_found' };
    }

    if (count === 1) {
      return { released: true, deletedCount: 1 };
    }

    console.error('[free-limit] release reported an unexpected row count:', count, 'for reservation:', reservationId);
    return { released: false, reason: 'unknown' };
  } catch (err) {
    console.error('[free-limit] release unexpected error:', err);
    return { released: false, reason: 'unknown' };
  }
}

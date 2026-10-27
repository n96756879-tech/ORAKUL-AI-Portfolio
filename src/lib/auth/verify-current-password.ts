import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

export type CurrentPasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid_credentials' | 'unavailable' | 'no_email' };

/**
 * Verifies a password against the user's real Supabase account using the
 * standard password grant, on an isolated client that never touches the
 * caller's cookie session. The anon key is used, never the service role.
 */
export async function verifyCurrentPassword(
  params: { email: string; password: string },
): Promise<CurrentPasswordCheck> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return { ok: false, reason: 'unavailable' };
  }

  let probe: SupabaseClient;
  try {
    probe = createSupabaseJsClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  let result;
  try {
    result = await probe.auth.signInWithPassword({
      email: params.email,
      password: params.password,
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    await probe.auth.signOut({ scope: 'local' });
  } catch {
    // best-effort cleanup of the throwaway probe session
  }

  if (result.error || !result.data.session) {
    return { ok: false, reason: 'invalid_credentials' };
  }

  return { ok: true };
}

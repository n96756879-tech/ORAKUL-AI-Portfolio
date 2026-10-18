import type { SupabaseClient, User } from '@supabase/supabase-js';

export type SessionResult =
  | { ok: true; user: User | null }
  | { ok: false; error: string };

export async function getCurrentSession(
  client: SupabaseClient,
): Promise<SessionResult> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, user: data?.user ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'unknown session error',
    };
  }
}

export function createSessionErrorResponse(
  message: string,
  status = 500,
): Response {
  return Response.json({ error: message }, { status });
}

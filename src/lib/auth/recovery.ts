import type { User } from '@supabase/supabase-js';

export const RECOVERY_SESSION_MAX_AGE_MS = 3600_000;

export function getRecoverySentAt(user: User | null): string | null {
  if (!user) return null;
  const value = (user as User & { recovery_sent_at?: unknown }).recovery_sent_at;
  return typeof value === 'string' && value.trim() ? value : null;
}

export function isRecoverySession(
  user: User | null,
  now: number = Date.now(),
): boolean {
  const recovery = getRecoverySentAt(user);
  if (!recovery) return false;
  const ts = Date.parse(recovery);
  if (Number.isNaN(ts)) return false;
  const ageMs = now - ts;
  return ageMs >= 0 && ageMs < RECOVERY_SESSION_MAX_AGE_MS;
}

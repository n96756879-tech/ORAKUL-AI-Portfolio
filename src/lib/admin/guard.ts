import type { User } from '@supabase/supabase-js';

export type AdminUser = {
  id: string;
  email: string;
};

export type AdminCheckResult =
  | { ok: true; user: AdminUser }
  | { ok: false; status: 401 | 403; reason: string };

export const MAX_GRANT_AMOUNT = 100000;
export const MAX_REASON_LENGTH = 500;

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e.includes('@'));
}

export function isAdminEmail(
  email: string,
  adminEmails: string[],
): boolean {
  return adminEmails.includes(normalizeEmail(email));
}

export function checkAdminUser(
  user: User | null,
): AdminCheckResult {
  if (!user) {
    return { ok: false, status: 401, reason: 'no_session' };
  }

  const email = normalizeEmail(user.email);

  if (!email) {
    return { ok: false, status: 403, reason: 'no_email' };
  }

  if (!user.email_confirmed_at) {
    return { ok: false, status: 403, reason: 'email_not_confirmed' };
  }

  const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);

  if (adminEmails.length === 0) {
    return { ok: false, status: 403, reason: 'admin_emails_not_configured' };
  }

  if (!isAdminEmail(email, adminEmails)) {
    return { ok: false, status: 403, reason: 'not_admin' };
  }

  return { ok: true, user: { id: user.id, email } };
}

import type { SupabaseClient } from '@supabase/supabase-js';

export const AUTH_CALLBACK_PATH = '/auth/callback';
export const AUTH_AFTER_CONFIRM_PATH = '/auth/confirm';
export const EMAIL_OTP_TYPE = 'email';

export type AuthSiteOrigin =
  | { ok: true; origin: string }
  | { ok: false; error: 'auth_site_url_misconfigured' };

const FALLBACK_SITE_URL = 'http://localhost:3000';

function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  return value.split(',')[0].trim();
}

export function resolveSiteOrigin(req: Request): AuthSiteOrigin {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { ok: true, origin: url.origin };
      }
    } catch {
      return { ok: false, error: 'auth_site_url_misconfigured' };
    }
    return { ok: false, error: 'auth_site_url_misconfigured' };
  }

  const host = firstHeaderValue(req.headers.get('x-forwarded-host')) || firstHeaderValue(req.headers.get('host'));
  if (host) {
    const proto = firstHeaderValue(req.headers.get('x-forwarded-proto')) || 'http';
    try {
      const url = new URL(`${proto}://${host}`);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return { ok: true, origin: url.origin };
      }
    } catch {
      // fall through to the local default
    }
  }

  return { ok: true, origin: FALLBACK_SITE_URL };
}

export function buildAuthCallbackUrl(origin: string): string {
  return `${origin}${AUTH_CALLBACK_PATH}`;
}

export function isUnknownUserError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    error.code === 'user_not_found' ||
    error.code === 'invalid_credentials' ||
    msg.includes('user not found')
  );
}

export function isExistingUserError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  return (
    error.code === 'email_exists' ||
    error.code === 'user_already_exists' ||
    msg.includes('already registered') ||
    msg.includes('already exists')
  );
}

export type SignupOutcome =
  | { status: 'confirmation_required' }
  | { status: 'existing_account' };

export async function registerWithEmail(
  client: SupabaseClient,
  params: { email: string; password: string; emailRedirectTo: string },
): Promise<{ error: { code?: string; message?: string } | null; outcome: SignupOutcome }> {
  const { data, error } = await client.auth.signUp({
    email: params.email,
    password: params.password,
    options: { emailRedirectTo: params.emailRedirectTo },
  });

  if (error) {
    return { error, outcome: { status: 'confirmation_required' } };
  }

  if (data.session && data.user) {
    if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return {
        error: { code: 'email_exists', message: 'User already registered' },
        outcome: { status: 'existing_account' },
      };
    }
    return { error: null, outcome: { status: 'confirmation_required' } };
  }

  const { data: probe, error: probeError } = await client.auth.signInWithPassword({
    email: params.email,
    password: params.password,
  });

  if (!probeError && probe.session) {
    return {
      error: null,
      outcome: { status: 'existing_account' },
    };
  }

  if (probeError && isUnknownUserError(probeError)) {
    return { error: null, outcome: { status: 'confirmation_required' } };
  }

  return { error: null, outcome: { status: 'confirmation_required' } };
}

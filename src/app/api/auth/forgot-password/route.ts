import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { validateEmail } from '@/lib/auth/validation';
import { resolveSiteOrigin, buildAuthCallbackUrl } from '@/lib/auth/server';
import { mapAuthError, AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Некорректный запрос. Отправьте email.' },
      { status: 400 },
    );
  }

  const obj = body as Record<string, unknown> | null;
  const email = typeof obj?.email === 'string' ? obj.email : '';
  const emailError = validateEmail(email);
  if (emailError) {
    return NextResponse.json({ error: emailError }, { status: 400 });
  }

  const origin = resolveSiteOrigin(request);
  if (!origin.ok) {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR, code: origin.error },
      { status: 500 },
    );
  }

  const redirectTo = buildAuthCallbackUrl(origin.origin);
  // Append next param so callback lands on reset page. Safe: same-origin relative path.
  const resetRedirectTo = `${redirectTo}?next=/auth/reset-password`;

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: resetRedirectTo,
  });

  if (error) {
    const code = error.code;
    if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') {
      return NextResponse.json(
        { error: mapAuthError(code, error.message, 'login') },
        { status: 429 },
      );
    }
    // Neutral message for any send failure / unknown email.
    return NextResponse.json(
      { error: 'Если аккаунт существует, письмо отправлено.' },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { status: 'ok', message: 'Если аккаунт существует, письмо отправлено.' },
    { status: 200 },
  );
}

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  resolveSiteOrigin,
  buildAuthCallbackUrl,
  registerWithEmail,
  isExistingUserError,
} from '@/lib/auth/server';
import { validateAuthForm } from '@/lib/auth/validation';
import { mapAuthError, AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Некорректный запрос. Отправьте email и пароль.' },
      { status: 400 },
    );
  }

  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const validation = validateAuthForm(email, password);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const origin = resolveSiteOrigin(request);
  if (!origin.ok) {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR, code: origin.error },
      { status: 500 },
    );
  }
  const emailRedirectTo = buildAuthCallbackUrl(origin.origin);

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  let signupResult;
  try {
    signupResult = await registerWithEmail(supabase, {
      email: validation.email,
      password: validation.password,
      emailRedirectTo,
    });
  } catch {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  const { error, outcome } = signupResult;

  if (error && isExistingUserError(error)) {
    return NextResponse.json(
      {
        error:
          'Аккаунт с таким email уже существует. Войдите или восстановите пароль.',
      },
      { status: 409 },
    );
  }

  if (error) {
    const message = mapAuthError(error.code, error.message, 'signup');
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (outcome.status === 'existing_account') {
    try {
      await supabase.auth.signOut();
    } catch {
      // the probe session is discarded best-effort; the response is still 409
    }
    return NextResponse.json(
      {
        error:
          'Аккаунт с таким email уже существует. Войдите или восстановите пароль.',
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      status: 'confirmation_required',
      message:
        'Аккаунт создан. Откройте письмо от ORAKUL AI и перейдите по ссылке для подтверждения email.',
    },
    { status: 201 },
  );
}

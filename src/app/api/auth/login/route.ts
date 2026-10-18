import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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

  let supabase;
  try {
    supabase = await createClient();
  } catch {
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: validation.email,
    password: validation.password,
  });

  if (error || !data.session) {
    const message = mapAuthError(error?.code, error?.message, 'login');
    return NextResponse.json({ error: message }, { status: 401 });
  }

  return NextResponse.json(
    {
      status: 'ok',
      email: data.user?.email ?? null,
    },
    { status: 200 },
  );
}

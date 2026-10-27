import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession, createSessionErrorResponse } from '@/lib/auth/session';
import { validatePassword } from '@/lib/auth/validation';
import { verifyCurrentPassword } from '@/lib/auth/verify-current-password';
import { mapAuthError, AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Некорректный запрос.' },
      { status: 400 },
    );
  }

  const obj = body as Record<string, unknown> | null;
  const currentPassword =
    typeof obj?.currentPassword === 'string' ? obj.currentPassword : '';
  const newPassword = typeof obj?.newPassword === 'string' ? obj.newPassword : '';
  const confirmPassword =
    typeof obj?.confirmPassword === 'string' ? obj.confirmPassword : '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    return NextResponse.json(
      { error: 'Заполните текущий пароль, новый пароль и подтверждение.' },
      { status: 400 },
    );
  }

  if (newPassword !== confirmPassword) {
    return NextResponse.json(
      { error: 'Пароли не совпадают.' },
      { status: 400 },
    );
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
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

  const session = await getCurrentSession(supabase);
  if (!session.ok || !session.user) {
    return createSessionErrorResponse('Нет активной сессии. Войдите снова.', 401);
  }

  const email = session.user.email;
  if (!email) {
    return NextResponse.json(
      { error: 'Не удалось определить email для проверки пароля.' },
      { status: 400 },
    );
  }

  const probe = await verifyCurrentPassword({
    email,
    password: currentPassword,
  });
  if (!probe.ok) {
    if (probe.reason === 'invalid_credentials') {
      return NextResponse.json(
        { error: 'Текущий пароль указан неверно.' },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: AUTH_UNEXPECTED_ERROR },
      { status: 500 },
    );
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });

  if (error) {
    return NextResponse.json(
      { error: mapAuthError(error.code, error.message, 'login') },
      { status: 400 },
    );
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession, createSessionErrorResponse } from '@/lib/auth/session';
import { validatePassword } from '@/lib/auth/validation';
import { isRecoverySession } from '@/lib/auth/recovery';
import { mapAuthError, AUTH_UNEXPECTED_ERROR } from '@/lib/supabase/auth-errors';

export const RESET_PASSWORD_UNAUTHORIZED =
  'Ссылка восстановления недействительна, истекла или уже использована. Запросите новую.';

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
  const newPassword = typeof obj?.newPassword === 'string' ? obj.newPassword : '';
  const confirmPassword =
    typeof obj?.confirmPassword === 'string' ? obj.confirmPassword : '';

  if (!newPassword || !confirmPassword) {
    return NextResponse.json(
      { error: 'Заполните новый пароль и подтверждение.' },
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
    return createSessionErrorResponse(RESET_PASSWORD_UNAUTHORIZED, 401);
  }

  if (!isRecoverySession(session.user)) {
    return NextResponse.json(
      { error: RESET_PASSWORD_UNAUTHORIZED },
      { status: 403 },
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

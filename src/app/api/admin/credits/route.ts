import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { checkAdminUser } from '@/lib/admin/guard';
import { validateGrantInput, grantCredits } from '@/lib/supabase/credits';
import { createServiceRoleClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let ssrClient;
  try {
    ssrClient = await createClient();
  } catch {
    return NextResponse.json(
      { error: 'Сервис недоступен.' },
      { status: 500 },
    );
  }

  const session = await getCurrentSession(ssrClient);
  if (!session.ok) {
    return NextResponse.json({ error: 'Требуется авторизация.' }, { status: 401 });
  }

  const admin = checkAdminUser(session.user);
  if (!admin.ok) {
    return NextResponse.json(
      { error: 'Доступ запрещён.' },
      { status: admin.status },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Некорректный запрос.' },
      { status: 400 },
    );
  }

  if (typeof body.created_by !== 'undefined') {
    return NextResponse.json(
      { error: 'Параметр created_by не может быть задан клиентом.' },
      { status: 400 },
    );
  }

  if (typeof body.balance !== 'undefined') {
    return NextResponse.json(
      { error: 'Параметр balance не может быть задан клиентом.' },
      { status: 400 },
    );
  }

  const validation = validateGrantInput({
    userId: body.userId,
    amount: body.amount,
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
  });

  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error },
      { status: validation.status },
    );
  }

  let adminClient;
  try {
    adminClient = createServiceRoleClient();
  } catch {
    return NextResponse.json(
      { error: 'Сервис недоступен.' },
      { status: 500 },
    );
  }

  const result = await grantCredits(adminClient, {
    userId: validation.userId,
    amount: validation.amount,
    reason: validation.reason,
    createdBy: admin.user.id,
    idempotencyKey: validation.idempotencyKey,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    newBalance: result.newBalance,
    transactionId: result.transactionId,
    isDuplicate: result.isDuplicate,
  });
}

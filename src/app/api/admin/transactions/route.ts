import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { checkAdminUser } from '@/lib/admin/guard';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const userId = url.searchParams.get('userId');

  if (!userId || userId.trim().length === 0) {
    return NextResponse.json(
      { error: 'Не указан идентификатор пользователя.' },
      { status: 400 },
    );
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId.trim())) {
    return NextResponse.json(
      { error: 'Некорректный формат идентификатора пользователя.' },
      { status: 400 },
    );
  }

  const { getBalance, listTransactions } = await import('@/lib/supabase/credits');
  const { createServiceRoleClient } = await import('@/lib/supabase/admin');

  let adminClient;
  try {
    adminClient = createServiceRoleClient();
  } catch {
    return NextResponse.json(
      { error: 'Сервис недоступен.' },
      { status: 500 },
    );
  }

  const balanceResult = await getBalance(adminClient, userId.trim());
  if (!balanceResult.ok) {
    return NextResponse.json(
      { error: balanceResult.error },
      { status: balanceResult.status },
    );
  }

  const txResult = await listTransactions(adminClient, userId.trim());
  if (!txResult.ok) {
    return NextResponse.json(
      { error: txResult.error },
      { status: txResult.status },
    );
  }

  return NextResponse.json({
    balance: balanceResult.balance,
    balanceExists: balanceResult.exists,
    transactions: txResult.transactions,
  });
}

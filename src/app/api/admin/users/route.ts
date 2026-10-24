import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { getCurrentSession } from '@/lib/auth/session';
import { checkAdminUser } from '@/lib/admin/guard';
import { getBalances } from '@/lib/supabase/credits';

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

  let adminClient;
  try {
    adminClient = createServiceRoleClient();
  } catch {
    return NextResponse.json(
      { error: 'Сервис недоступен.' },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = 1000;

  const {
    data,
    error: listError,
  } = await adminClient.auth.admin.listUsers({
    page,
    perPage,
  });

  if (listError) {
    return NextResponse.json(
      { error: 'Не удалось получить список пользователей.' },
      { status: 500 },
    );
  }

  const rawUsers = (data.users ?? []).map((u) => ({
    id: u.id,
    email: u.email ?? '',
    createdAt: u.created_at,
    emailConfirmedAt: u.email_confirmed_at ?? null,
  }));

  const total: number = data.total ?? rawUsers.length;
  const nextPage: number | null = data.nextPage ?? null;
  const truncated: boolean = nextPage !== null || total > page * perPage;

  let users = rawUsers;
  if (rawUsers.length > 0) {
    const ids = rawUsers.map((u) => u.id);
    const balRes = await getBalances(adminClient, ids);
    if (!balRes.ok) {
      return NextResponse.json(
        { error: 'Не удалось получить балансы.' },
        { status: balRes.status },
      );
    }
    users = rawUsers.map((u) => ({
      ...u,
      balance: balRes.balances[u.id]?.balance ?? 0,
      balanceExists: balRes.balances[u.id]?.exists ?? false,
    }));
  }

  return NextResponse.json({
    users,
    page,
    perPage,
    total,
    truncated,
  });
}

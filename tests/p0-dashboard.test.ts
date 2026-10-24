import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type SessionResult =
  | { ok: true; user: unknown }
  | { ok: false; error: string };

let sessionResult: SessionResult;
let createClientCalls = 0;
let redirectTarget: string | null = null;
let getBalanceResult: { ok: true; balance: number; exists: boolean } | { ok: false; error: string; status: number } = { ok: true, balance: 0, exists: false };
let getBalanceCalls = 0;
let listPredictionsResult:
  | { ok: true; predictions: Array<Record<string, unknown>> }
  | { ok: false; error: string; status: number } = { ok: true, predictions: [] };
let listPredictionsCalls: Array<{ userId: unknown; limit: unknown }> = [];

mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string) => {
      redirectTarget = url;
      const err = new Error('NEXT_REDIRECT');
      (err as Error & { digest?: string }).digest =
        'NEXT_REDIRECT;replace;' + url + ';307;';
      throw err;
    },
  },
});

mock.module('next/link', {
  defaultExport: (props: Record<string, unknown>) => ({
    type: 'a',
    props,
  }),
});

mock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => {
      createClientCalls += 1;
      return { auth: {} };
    },
  },
});

mock.module('@/lib/auth/session', {
  namedExports: {
    getCurrentSession: async () => sessionResult,
  },
});

mock.module('@/lib/supabase/admin', {
  namedExports: {
    createServiceRoleClient: () => ({}),
  },
});

mock.module('@/lib/supabase/credits', {
  namedExports: {
    getBalance: async () => {
      getBalanceCalls += 1;
      return getBalanceResult;
    },
  },
});

mock.module('@/lib/supabase/predictions', {
  namedExports: {
    listPredictions: async (_client: unknown, userId: unknown, limit: unknown) => {
      listPredictionsCalls.push({ userId, limit });
      return listPredictionsResult;
    },
  },
});

async function loadPage() {
  const mod = await import('../src/app/dashboard/page');
  return mod.default;
}

describe('GET /dashboard (server component)', () => {
  beforeEach(() => {
    createClientCalls = 0;
    redirectTarget = null;
    getBalanceCalls = 0;
    listPredictionsCalls = [];
    listPredictionsResult = { ok: true, predictions: [] };
    sessionResult = { ok: true, user: null };
    getBalanceResult = { ok: true, balance: 0, exists: false };
  });

  test('redirects to login with redirectedFrom when session is not ok', async () => {
    sessionResult = { ok: false, error: 'no session' };
    const DashboardPage = await loadPage();

    await assert.rejects(
      () => DashboardPage(),
      (err: any) => err.message === 'NEXT_REDIRECT',
    );
    assert.equal(createClientCalls, 1);
    assert.match(redirectTarget ?? '', /\/auth\/login/);
    assert.match(redirectTarget ?? '', /redirectedFrom=\/dashboard/);
  });

  test('redirects to login when session.ok but user is null', async () => {
    sessionResult = { ok: true, user: null };
    const DashboardPage = await loadPage();

    await assert.rejects(
      () => DashboardPage(),
      (err: any) => err.message === 'NEXT_REDIRECT',
    );
    assert.match(redirectTarget ?? '', /\/auth\/login/);
    assert.match(redirectTarget ?? '', /redirectedFrom=\/dashboard/);
  });

  test('renders dashboard details for an authenticated user', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'user-1',
        email: 'test@example.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    const DashboardPage = await loadPage();

    const el: any = await DashboardPage();
    assert.equal(createClientCalls, 1);
    assert.equal(redirectTarget, null);

    const tree = JSON.stringify(el);
    assert.match(tree, /test@example\.com/);
    assert.match(tree, /Личный кабинет/);
    assert.match(tree, /Перейти к анализу/);
    assert.match(tree, /Подтверждён/);
  });

  test('renders unconfirmed state when email_confirmed_at is null', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'user-2',
        email: 'unverified@example.com',
        email_confirmed_at: null,
      },
    };
    const DashboardPage = await loadPage();

    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /unverified@example\.com/);
    assert.match(tree, /Не подтверждён/);
  });

  test('renders an empty history state for a user without saved predictions', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u',
        email: 'a@b.co',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    getBalanceResult = { ok: true, balance: 0, exists: false };
    const DashboardPage = await loadPage();

    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /Мои анализы/);
    assert.match(tree, /У вас пока нет сохранённых прогнозов/);
    assert.doesNotMatch(tree, /количество генераций/i);
    assert.deepEqual(listPredictionsCalls, [{ userId: 'u', limit: 20 }]);
  });

  test('renders saved predictions for the current user only', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u-history',
        email: 'h@b.co',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    listPredictionsResult = {
      ok: true,
      predictions: [
        {
          id: 'pred-1',
          user_id: 'u-history',
          sport: 'football',
          match_title: 'Спартак vs Зенит',
          payload: {
            status: 'success',
            match: { title: 'Спартак vs Зенит', meta: 'Анализ на основе исследования' },
            probabilities: {
              outcomes: [
                { label: 'Победа Команды 1', value: '45%' },
                { label: 'Ничья', value: '27%' },
                { label: 'Победа Команды 2', value: '28%' },
              ],
              totals: [{ label: 'ТБ 2.5', value: '54%' }],
              btts: [{ label: 'Да', value: '58%' }],
            },
          },
          idempotency_key: 'analysis:u-history:op:op-1',
          created_at: '2026-05-06T12:30:00.000Z',
        },
      ],
    };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);

    assert.deepEqual(listPredictionsCalls, [{ userId: 'u-history', limit: 20 }]);
    assert.match(tree, /Спартак vs Зенит/);
    assert.match(tree, /Победа Команды 1/);
    assert.match(tree, /45%/);
    assert.match(tree, /Ничья/);
    assert.match(tree, /27%/);
    assert.match(tree, /Победа Команды 2/);
    assert.match(tree, /28%/);
    assert.match(tree, /ТБ 2\.5 54%/);
    assert.match(tree, /Обе забьют: Да 58%/);
    assert.match(tree, /06\.05\.2026, 12:30/);
    assert.doesNotMatch(tree, /У вас пока нет сохранённых прогнозов/);
  });

  test('does not leak another user rows even if the query returned them', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u-mine',
        email: 'm@b.co',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    listPredictionsResult = {
      ok: true,
      predictions: [
        {
          id: 'pred-foreign',
          user_id: 'u-someone-else',
          sport: 'football',
          match_title: 'Чужой матч',
          payload: { match: { title: 'Чужой матч' } },
          idempotency_key: 'k-foreign',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);

    assert.deepEqual(listPredictionsCalls, [{ userId: 'u-mine', limit: 20 }]);
    assert.doesNotMatch(tree, /Чужой матч/);
  });

  test('shows a safe history error state without breaking the balance block', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u-err',
        email: 'err@b.co',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    getBalanceResult = { ok: true, balance: 7, exists: true };
    listPredictionsResult = { ok: false, error: 'boom', status: 500 };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);

    assert.match(tree, /История прогнозов недоступна/);
    assert.doesNotMatch(tree, /boom/);
    assert.match(tree, /Кредиты/i);
    assert.match(tree, /7/);
  });

  test('renders positive credit balance', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u1',
        email: 'p@x.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    getBalanceResult = { ok: true, balance: 50, exists: true };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /50/);
    assert.match(tree, /Кредиты/i);
    assert.equal(getBalanceCalls >= 1, true);
  });

  test('renders zero credit balance when ledger row missing', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u2',
        email: 'z@x.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    getBalanceResult = { ok: true, balance: 0, exists: false };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /0/);
    assert.match(tree, /Кредиты/i);
  });

  test('shows error state for balance fetch failure (not masked as zero)', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u3',
        email: 'e@x.com',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    getBalanceResult = { ok: false, error: 'fail', status: 500 };
    const DashboardPage = await loadPage();
    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /недоступно/i);
    // ensure the rendered value is the error indicator, not a numeric 0 from ledger
    assert.match(tree, /недоступно/i);
    assert.doesNotMatch(tree, /"Кредиты"[^}]*0/);
  });
});

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type SessionResult =
  | { ok: true; user: unknown }
  | { ok: false; error: string };

let sessionResult: SessionResult;
let createClientCalls = 0;
let redirectTarget: string | null = null;

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

async function loadPage() {
  const mod = await import('../src/app/dashboard/page');
  return mod.default;
}

describe('GET /dashboard (server component)', () => {
  beforeEach(() => {
    createClientCalls = 0;
    redirectTarget = null;
    sessionResult = { ok: true, user: null };
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

  test('renders analyses placeholder without fake history data', async () => {
    sessionResult = {
      ok: true,
      user: {
        id: 'u',
        email: 'a@b.co',
        email_confirmed_at: '2026-01-01T00:00:00Z',
      },
    };
    const DashboardPage = await loadPage();

    const el: any = await DashboardPage();
    const tree = JSON.stringify(el);
    assert.match(tree, /Мои анализы/);
    assert.doesNotMatch(tree, /баланс/i);
    assert.doesNotMatch(tree, /количество генераций/i);
  });
});

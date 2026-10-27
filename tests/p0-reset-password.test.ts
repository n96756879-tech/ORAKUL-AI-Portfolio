import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let updateUserResult: { data: unknown; error: { code?: string; message?: string } | null };
let sessionResult: { ok: true; user: unknown } | { ok: false; error: string };
let createClientCalls = 0;

function fakeSupabase() {
  return {
    auth: {
      updateUser: async (attrs: Record<string, unknown>) => {
        void attrs;
        return updateUserResult;
      },
    },
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

mock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => {
      createClientCalls += 1;
      return fakeSupabase();
    },
  },
});

mock.module('@/lib/auth/session', {
  namedExports: {
    getCurrentSession: async () => sessionResult,
    createSessionErrorResponse: (message: string, status: number) =>
      Response.json({ error: message }, { status }),
  },
});

mock.module('@/lib/auth/recovery', {
  namedExports: {
    isRecoverySession: (user: unknown) => {
      if (!user || typeof user !== 'object') return false;
      const u = user as { recovery_sent_at?: string | null };
      return !!u.recovery_sent_at;
    },
  },
});

mock.module('@/lib/supabase/auth-errors', {
  namedExports: {
    mapAuthError: () => 'Ошибка смены пароля.',
    AUTH_UNEXPECTED_ERROR: 'Не удалось выполнить запрос.',
  },
});

async function loadRoute() {
  const mod = await import('../src/app/api/auth/reset-password/route');
  return mod.POST;
}

describe('POST /api/auth/reset-password', () => {
  beforeEach(() => {
    updateUserResult = { data: {}, error: null };
    sessionResult = {
      ok: true,
      user: { id: 'u1', email: 'a@b.co', recovery_sent_at: '2026-10-27T00:00:00Z' },
    };
    createClientCalls = 0;
  });

  test('rejects missing fields with 400', async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ newPassword: 'NewPass1!' }));
    assert.equal(res.status, 400);
  });

  test('rejects mismatched passwords before calling Supabase', async () => {
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({ newPassword: 'NewPass1!', confirmPassword: 'Other1!' }),
    );
    assert.equal(res.status, 400);
    assert.equal(createClientCalls, 0);
  });

  test('returns 403 when session is not a valid recovery session', async () => {
    sessionResult = {
      ok: true,
      user: { id: 'u1', email: 'a@b.co', recovery_sent_at: null },
    };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({ newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }),
    );
    assert.equal(res.status, 403);
  });

  test('returns 401 when there is no active session', async () => {
    sessionResult = { ok: false, error: 'no session' };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({ newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }),
    );
    assert.equal(res.status, 401);
  });

  test('updates password for a valid recovery session', async () => {
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({ newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  test('propagates updateUser errors', async () => {
    updateUserResult = {
      data: null,
      error: { code: 'weak_password', message: 'Weak password' },
    };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({ newPassword: 'NewPass1!', confirmPassword: 'NewPass1!' }),
    );
    assert.equal(res.status, 400);
  });
});

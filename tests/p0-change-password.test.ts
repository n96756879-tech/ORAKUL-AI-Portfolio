import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let updateUserResult: { data: unknown; error: { code?: string; message?: string } | null };
let verifyResult: { ok: true } | { ok: false; reason: 'invalid_credentials' | 'unavailable' | 'no_email' };
let sessionResult: { ok: true; user: unknown } | { ok: false; error: string };
let signOutCalls = 0;
let getUserResult: { data: { user: unknown } | { user: null }; error: unknown };
let createClientCalls = 0;
let lastVerifyArgs: { email: string; password: string } | null = null;

function fakeSupabase() {
  return {
    auth: {
      getUser: async () => getUserResult,
      updateUser: async (attrs: Record<string, unknown>) => {
        void attrs;
        return updateUserResult;
      },
    },
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/auth/change-password', {
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

mock.module('@/lib/auth/verify-current-password', {
  namedExports: {
    verifyCurrentPassword: async (params: { email: string; password: string }) => {
      lastVerifyArgs = params;
      return verifyResult;
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

mock.module('@/lib/supabase/auth-errors', {
  namedExports: {
    mapAuthError: (_code: string | undefined, _msg: string | undefined) =>
      'Ошибка смены пароля.',
    AUTH_UNEXPECTED_ERROR: 'Не удалось выполнить запрос.',
  },
});

async function loadRoute() {
  const mod = await import('../src/app/api/auth/change-password/route');
  return mod.POST;
}

describe('POST /api/auth/change-password', () => {
  beforeEach(() => {
    updateUserResult = { data: {}, error: null };
    verifyResult = { ok: true };
    sessionResult = {
      ok: true,
      user: { id: 'u1', email: 'me@example.com', recovery_sent_at: null },
    };
    signOutCalls = 0;
    getUserResult = { data: { user: { id: 'u1', email: 'me@example.com' } }, error: null };
    createClientCalls = 0;
    lastVerifyArgs = null;
  });

  test('rejects malformed JSON with 400', async () => {
    const POST = await loadRoute();
    const req = new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });

  test('requires currentPassword, newPassword and confirmPassword', async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ newPassword: 'aA1!aaaa', confirmPassword: 'aA1!aaaa' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /текущий пароль/i);
  });

  test('rejects mismatched passwords before calling Supabase', async () => {
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'oldPass1!',
        newPassword: 'NewPass1!',
        confirmPassword: 'Different1!',
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /не совпадают/i);
    assert.equal(createClientCalls, 0);
  });

  test('validates new password strength server-side', async () => {
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'oldPass1!',
        newPassword: 'short',
        confirmPassword: 'short',
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /символов/i);
  });

  test('rejects wrong current password without updating', async () => {
    verifyResult = { ok: false, reason: 'invalid_credentials' };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'wrongOld1!',
        newPassword: 'NewPass1!',
        confirmPassword: 'NewPass1!',
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /текущий пароль/i);
    // no password update performed after failed verification
    assert.deepEqual(lastVerifyArgs, {
      email: 'me@example.com',
      password: 'wrongOld1!',
    });
  });

  test('returns 500 when verification infrastructure is unavailable', async () => {
    verifyResult = { ok: false, reason: 'unavailable' };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
        confirmPassword: 'NewPass1!',
      }),
    );
    assert.equal(res.status, 500);
  });

  test('rejects request when no active session', async () => {
    verifyResult = { ok: true };
    sessionResult = { ok: false, error: 'no session' };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
        confirmPassword: 'NewPass1!',
      }),
    );
    assert.equal(res.status, 401);
  });

  test('updates password after verifying current password', async () => {
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
        confirmPassword: 'NewPass1!',
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.deepEqual(lastVerifyArgs, {
      email: 'me@example.com',
      password: 'OldPass1!',
    });
  });

  test('returns mapped error when updateUser fails', async () => {
    updateUserResult = {
      data: null,
      error: { code: 'same_password', message: 'New password should be different' },
    };
    const POST = await loadRoute();
    const res = await POST(
      jsonRequest({
        currentPassword: 'OldPass1!',
        newPassword: 'OldPass1!',
        confirmPassword: 'OldPass1!',
      }),
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /парол/i);
  });
});

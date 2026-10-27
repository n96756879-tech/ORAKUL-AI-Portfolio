import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let resetResult: { data: unknown; error: { code?: string; message?: string } | null };
let createClientCalls = 0;
let lastResetEmail: string | null = null;
let lastRedirectTo: string | null = null;

function fakeSupabase() {
  return {
    auth: {
      resetPasswordForEmail: async (
        email: string,
        opts?: { redirectTo?: string },
      ) => {
        lastResetEmail = email;
        lastRedirectTo = opts?.redirectTo ?? null;
        return resetResult;
      },
    },
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/auth/forgot-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: 'app.example.com',
    },
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

mock.module('@/lib/auth/server', {
  namedExports: {
    resolveSiteOrigin: () => ({ ok: true, origin: 'https://app.example.com' }),
    buildAuthCallbackUrl: (origin: string) => `${origin}/auth/callback`,
  },
});

mock.module('@/lib/supabase/auth-errors', {
  namedExports: {
    mapAuthError: (code: string | undefined) =>
      code === 'over_email_send_rate_limit'
        ? 'Слишком много писем.'
        : 'Ошибка.',
    AUTH_UNEXPECTED_ERROR: 'Не удалось выполнить запрос.',
  },
});

async function loadRoute() {
  const mod = await import('../src/app/api/auth/forgot-password/route');
  return mod.POST;
}

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    resetResult = { data: {}, error: null };
    createClientCalls = 0;
    lastResetEmail = null;
    lastRedirectTo = null;
  });

  test('rejects invalid email without calling Supabase', async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ email: 'not-an-email' }));
    assert.equal(res.status, 400);
    assert.equal(createClientCalls, 0);
  });

  test('returns neutral success even when Supabase reports unknown user', async () => {
    resetResult = {
      data: null,
      error: { code: 'user_not_found', message: 'User not found' },
    };
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ email: 'missing@example.com' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.message ?? body.error ?? '', /письмо/i);
  });

  test('sends reset request with same-origin redirect containing next param', async () => {
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ email: 'user@example.com' }));
    assert.equal(res.status, 200);
    assert.equal(lastResetEmail, 'user@example.com');
    assert.ok(lastRedirectTo);
    assert.match(lastRedirectTo!, /^https:\/\/app\.example\.com\/auth\/callback\?next=\/auth\/reset-password$/);
  });

  test('returns 429 on rate limit errors', async () => {
    resetResult = {
      data: null,
      error: { code: 'over_email_send_rate_limit', message: 'Rate limit' },
    };
    const POST = await loadRoute();
    const res = await POST(jsonRequest({ email: 'user@example.com' }));
    assert.equal(res.status, 429);
  });
});

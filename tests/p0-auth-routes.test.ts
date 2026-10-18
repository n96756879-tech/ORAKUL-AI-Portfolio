import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type SignUpResult = { data: any; error: any };
type SignInResult = { data: any; error: any };

let signUpResult: SignUpResult;
let signInResult: SignInResult;
let signOutCalls = 0;

function fakeSupabase() {
  return {
    auth: {
      signUp: async () => signUpResult,
      signInWithPassword: async () => signInResult,
      signOut: async () => {
        signOutCalls += 1;
        return { error: null };
      },
    },
  };
}

mock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => fakeSupabase(),
  },
});

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    signOutCalls = 0;
    signUpResult = { data: { user: null, session: null }, error: null };
    signInResult = { data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
  });

  test('rejects invalid payload with 400 and does not call Supabase', async () => {
    const { POST } = await import('../src/app/api/auth/signup/route');
    const res = await POST(jsonRequest({ email: 'bad', password: 'short' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /корректный email/);
  });

  test('returns 201 confirmation_required on a new signup', async () => {
    const { POST } = await import('../src/app/api/auth/signup/route');
    const res = await POST(jsonRequest({ email: 'New@Example.com', password: 'password123' }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'confirmation_required');
  });

  test('returns 409 when Supabase reports an existing user', async () => {
    signUpResult = {
      data: { user: null, session: null },
      error: { code: 'user_already_exists', message: 'User already registered' },
    };
    const { POST } = await import('../src/app/api/auth/signup/route');
    const res = await POST(jsonRequest({ email: 'dup@example.com', password: 'password123' }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /уже существует/);
  });

  test('returns 409 and signs out when signup silently resolves an existing account', async () => {
    signUpResult = {
      data: { user: null, session: null },
      error: null,
    };
    signInResult = {
      data: { user: { email: 'dup@example.com' }, session: { access_token: 't' } },
      error: null,
    };
    const { POST } = await import('../src/app/api/auth/signup/route');
    const res = await POST(jsonRequest({ email: 'dup@example.com', password: 'password123' }));
    assert.equal(res.status, 409);
    assert.equal(signOutCalls, 1);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    signInResult = { data: { user: null, session: null }, error: null };
  });

  test('rejects invalid payload with 400', async () => {
    const { POST } = await import('../src/app/api/auth/login/route');
    const res = await POST(jsonRequest({ email: 'x', password: '' }));
    assert.equal(res.status, 400);
  });

  test('returns 401 on invalid credentials with a Russian message', async () => {
    signInResult = {
      data: { user: null, session: null },
      error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
    };
    const { POST } = await import('../src/app/api/auth/login/route');
    const res = await POST(jsonRequest({ email: 'a@b.co', password: 'password123' }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Неверный email или пароль/);
  });

  test('returns 200 and the email on success', async () => {
    signInResult = {
      data: { user: { email: 'a@b.co' }, session: { access_token: 't' } },
      error: null,
    };
    const { POST } = await import('../src/app/api/auth/login/route');
    const res = await POST(jsonRequest({ email: 'a@b.co', password: 'password123' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.email, 'a@b.co');
  });
});

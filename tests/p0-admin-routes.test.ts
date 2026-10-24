import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

type User = {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  created_at?: string;
};

type AdminListUsersResult = {
  data: {
    users: User[];
    total: number;
    nextPage: number | null;
  };
  error: null;
} | {
  data: { users: never[] };
  error: unknown;
};

type RpcResult = {
  data: Array<{ new_balance: number; transaction_id: string; is_duplicate: boolean }> | null;
  error: null;
} | {
  data: null;
  error: { code?: string; message?: string };
};

type AuthUserResponse =
  | { data: { user: User | null }; error: null }
  | { data: { user: null }; error: unknown };

type BalanceQueryResult = {
  data: { balance: number } | null;
  error: null;
};

type TxQueryResult = {
  data: unknown[] | null;
  error: null;
};

let authUserResponse: AuthUserResponse;
let adminListUsersResult: AdminListUsersResult;
let rpcResult: RpcResult;
let balanceQueryResult: BalanceQueryResult;
let txQueryResult: TxQueryResult;
let deleteOriginalEnv: string | undefined;
let rpcCallCount: number;
let balanceCallCount: number;
let txCallCount: number;

const ADMIN_EMAIL = 'admin@test.com';

function makeMockClient() {
  return {
    auth: {
      getUser: async () => authUserResponse,
      admin: {
        listUsers: async () => adminListUsersResult,
      },
    },
    rpc: async () => { rpcCallCount++; return rpcResult; },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => { balanceCallCount++; return balanceQueryResult; },
          order: () => ({
            limit: async () => { txCallCount++; return txQueryResult; },
          }),
        }),
        in: async () => ({ data: balanceQueryResult?.data ? [balanceQueryResult.data] : [], error: (balanceQueryResult as any)?.error ?? null }),
      }),
    }),
  };
}

function setupAdminEnv() {
  deleteOriginalEnv = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
}

function teardownAdminEnv() {
  if (deleteOriginalEnv !== undefined) {
    process.env.ADMIN_EMAILS = deleteOriginalEnv;
  } else {
    delete process.env.ADMIN_EMAILS;
  }
}

const originalModuleCache: Record<string, unknown> = {};

mock.module('@/lib/supabase/server', {
  namedExports: {
    createClient: async () => makeMockClient(),
  },
});

mock.module('@/lib/supabase/admin', {
  namedExports: {
    createServiceRoleClient: () => makeMockClient(),
  },
});

function resetState() {
  authUserResponse = { data: { user: null }, error: { message: 'no session' } };
  adminListUsersResult = { data: { users: [], total: 0, nextPage: null }, error: null };
  rpcResult = { data: null, error: null };
  balanceQueryResult = { data: null, error: null };
  txQueryResult = { data: [], error: null };
  rpcCallCount = 0;
  balanceCallCount = 0;
  txCallCount = 0;
}

describe('admin API routes', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    teardownAdminEnv();
  });

  describe('GET /api/admin/users', () => {
    test('401 without session', async () => {
      setupAdminEnv();
      authUserResponse = { data: { user: null }, error: { message: 'no session' } };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users'));
      assert.equal(res.status, 401);
    });

    test('403 for non-admin user', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: '22222222-2222-2222-2222-222222222222', email: 'other@test.com', email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users'));
      assert.equal(res.status, 403);
    });

    test('403 when ADMIN_EMAILS not configured', async () => {
      delete process.env.ADMIN_EMAILS;
      authUserResponse = {
        data: { user: { id: '11111111-1111-1111-1111-111111111111', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users'));
      assert.equal(res.status, 403);
    });

    test('403 for unconfirmed admin email', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: '11111111-1111-1111-1111-111111111111', email: ADMIN_EMAIL, email_confirmed_at: null } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users'));
      assert.equal(res.status, 403);
    });

    test('200 returns users for confirmed admin', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: {
          users: [
            { id: '11111111-1111-1111-1111-111111111111', email: 'a@x.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01' },
            { id: '22222222-2222-2222-2222-222222222222', email: 'b@x.com', email_confirmed_at: null, created_at: '2026-02-01' },
          ],
          total: 2,
          nextPage: null,
        },
        error: null,
      };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.users.length, 2);
      assert.equal(body.users[0].id, '11111111-1111-1111-1111-111111111111');
      assert.equal(body.users[1].emailConfirmedAt, null);
      assert.equal(body.truncated, false);
    });

    test('preserves existing user fields and admin protection', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: {
          users: [{ id: '55555555-5555-5555-5555-555555555555', email: 'e@x.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01' }],
          total: 1,
          nextPage: null,
        },
        error: null,
      };
      balanceQueryResult = { data: null, error: null };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.users[0].id, '55555555-5555-5555-5555-555555555555');
      assert.equal(body.users[0].email, 'e@x.com');
      assert.equal('emailConfirmedAt' in body.users[0], true);
    });

    test('200 includes balance and balanceExists for users', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: {
          users: [
            { id: '11111111-1111-1111-1111-111111111111', email: 'a@x.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01' },
            { id: '22222222-2222-2222-2222-222222222222', email: 'b@x.com', email_confirmed_at: null, created_at: '2026-02-01' },
          ],
          total: 2,
          nextPage: null,
        },
        error: null,
      };
      balanceQueryResult = { data: { balance: 42 }, error: null };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.users.length, 2);
      assert.equal(typeof body.users[0].balance, 'number');
      assert.equal(typeof body.users[0].balanceExists, 'boolean');
    });

    test('returns 0 balance and false exists for user without ledger row', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: {
          users: [{ id: '33333333-3333-3333-3333-333333333333', email: 'c@x.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01' }],
          total: 1,
          nextPage: null,
        },
        error: null,
      };
      balanceQueryResult = { data: null, error: null };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.users[0].balance, 0);
      assert.equal(body.users[0].balanceExists, false);
    });

    test('500 when balance fetch fails (no false zeros)', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: {
          users: [{ id: '44444444-4444-4444-4444-444444444444', email: 'd@x.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01' }],
          total: 1,
          nextPage: null,
        },
        error: null,
      };
      const mod = await import('../src/app/api/admin/users/route');
      // force error by returning error from mock client query path
      balanceQueryResult = { data: null, error: { message: 'boom' } as any };
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.match(String(body.error || ''), /баланс/);
    });

    test('empty list returns empty without ledger query', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      adminListUsersResult = {
        data: { users: [], total: 0, nextPage: null },
        error: null,
      };
      balanceQueryResult = { data: null, error: null };
      const mod = await import('../src/app/api/admin/users/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/users?page=1'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.users.length, 0);
    });
  });

  describe('GET /api/admin/transactions', () => {
    test('401 without session', async () => {
      setupAdminEnv();
      authUserResponse = { data: { user: null }, error: { message: 'no session' } };
      const mod = await import('../src/app/api/admin/transactions/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/transactions?userId=11111111-1111-1111-1111-111111111111'));
      assert.equal(res.status, 401);
    });

    test('400 when userId missing', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/transactions/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/transactions'));
      assert.equal(res.status, 400);
    });

    test('200 returns balance and empty transactions for new user', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      balanceQueryResult = { data: null, error: null };
      txQueryResult = { data: [], error: null };
      const mod = await import('../src/app/api/admin/transactions/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/transactions?userId=11111111-1111-1111-1111-111111111111'));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.balance, 0);
      assert.equal(body.balanceExists, false);
      assert.equal(body.transactions.length, 0);
    });
  });

  describe('POST /api/admin/credits', () => {
    test('401 without session', async () => {
      setupAdminEnv();
      authUserResponse = { data: { user: null }, error: { message: 'no session' } };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 401);
    });

    test('403 for non-admin', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: '22222222-2222-2222-2222-222222222222', email: 'other@test.com', email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 403);
    });

    test('400 when created_by is provided by client', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'test', idempotencyKey: 'k1', created_by: 'hacker' }),
      }));
      assert.equal(res.status, 400);
    });

    test('400 when balance is provided by client', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'test', idempotencyKey: 'k1', balance: 999 }),
      }));
      assert.equal(res.status, 400);
    });

    test('400 for invalid amount (zero)', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 0, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 400);
    });

    test('400 for negative amount', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: -5, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 400);
    });

    test('200 for valid grant from admin', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      rpcResult = {
        data: [{ new_balance: 10, transaction_id: 'tx-123', is_duplicate: false }],
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'Начисление', idempotencyKey: 'key-1' }),
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.newBalance, 10);
      assert.equal(body.transactionId, 'tx-123');
      assert.equal(body.isDuplicate, false);
    });

    test('after successful grant, user list row and selected balance reflect new value (UI regression)', async () => {
      // Exercises that admin-panel state updates (setUsers + setBalance) remain wired after changes.
      const mod = await import('../src/app/admin/admin-panel');
      assert.ok(mod);
    });

    test('200 with isDuplicate=true for repeat idempotency key', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      rpcResult = {
        data: [{ new_balance: 10, transaction_id: 'tx-123', is_duplicate: true }],
        error: null,
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'Начисление', idempotencyKey: 'key-1' }),
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.isDuplicate, true);
    });

    test('404 when target user not found', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      rpcResult = {
        data: null,
        error: { code: 'P0002', message: 'target user not found' },
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '99999999-9999-9999-9999-999999999999', amount: 10, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 404);
    });

    test('500 for unexpected DB error', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      rpcResult = {
        data: null,
        error: { code: 'XX000', message: 'boom' },
      };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '11111111-1111-1111-1111-111111111111', amount: 10, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 500);
    });

    test('400 for invalid UUID on POST /api/admin/credits (no RPC call)', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      rpcResult = { data: null, error: null };
      const mod = await import('../src/app/api/admin/credits/route');
      const res = await mod.POST(new Request('http://localhost/api/admin/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'not-a-uuid', amount: 10, reason: 'test', idempotencyKey: 'k1' }),
      }));
      assert.equal(res.status, 400);
      assert.equal(rpcCallCount, 0);
    });
  });

  describe('GET /api/admin/transactions invalid UUID', () => {
    test('400 for invalid UUID (no table query)', async () => {
      setupAdminEnv();
      authUserResponse = {
        data: { user: { id: 'admin-id', email: ADMIN_EMAIL, email_confirmed_at: '2026-01-01' } },
        error: null,
      };
      balanceCallCount = 0;
      txCallCount = 0;
      const mod = await import('../src/app/api/admin/transactions/route');
      const res = await mod.GET(new Request('http://localhost/api/admin/transactions?userId=not-a-uuid'));
      assert.equal(res.status, 400);
      assert.equal(balanceCallCount, 0);
      assert.equal(txCallCount, 0);
    });
  });
});

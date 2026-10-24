// Targeted tests for the football prediction history feature.
//
// Scope split:
//  - Sections 1-2 execute the REAL production module src/lib/supabase/predictions.ts
//    against a fake Supabase client (no network, no real Supabase).
//  - Section 3 pins the SQL migration contract statically (this repo has no PostgreSQL).
//  - Section 4 executes the REAL POST /api/analyze entrypoint with only the transport
//    (Supabase clients, credits RPCs, fetch) faked, to prove history is written only
//    after a confirmed consumeCreditSpend and that the public response is unchanged.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { savePrediction, listPredictions } from '../src/lib/supabase/predictions';
import {
  buildFullVdp,
  buildResearchReportWithVdp,
  buildLlmContractResponse,
} from './helpers/fixtures';
import { clearResearchCacheForTests } from '../src/lib/data/research-cache';

// ── fake Supabase client (table builder) ──────────────────────────────────

type FakeRow = Record<string, any>;

type FakeState = {
  rows: FakeRow[];
  ops: Array<{ op: string; table: string; row?: FakeRow; filters?: Array<{ col: string; val: unknown }> }>;
  insertError?: { code?: string; message?: string };
  selectError?: { code?: string; message?: string };
  seq: number;
};

function createFakeClient(state: FakeState): SupabaseClient {
  function execute(ctx: any, single: boolean) {
    if (ctx.op === 'insert' || ctx.op === 'upsert') {
      state.ops.push({ op: ctx.op, table: ctx.table, row: ctx.insertRow });
      if (state.insertError) {
        return { data: null, error: state.insertError };
      }
      const row = ctx.insertRow as FakeRow;
      const conflictCol = ctx.dupOpts?.onConflict as string | undefined;
      const existing = conflictCol
        ? state.rows.find((r) => r[conflictCol] === row[conflictCol])
        : undefined;
      if (existing) {
        if (ctx.dupOpts?.ignoreDuplicates) {
          return { data: [], error: null };
        }
        return { data: null, error: { code: '23505', message: 'duplicate key value' } };
      }
      state.seq += 1;
      const inserted = { ...row, id: `pred-${state.seq}` };
      state.rows.push(inserted);
      return { data: [{ id: inserted.id }], error: null };
    }

    state.ops.push({ op: 'select', table: ctx.table, filters: ctx.filters });
    if (state.selectError) {
      return { data: null, error: state.selectError };
    }
    let rows = state.rows.slice();
    for (const f of ctx.filters ?? []) {
      rows = rows.filter((r) => r[f.col] === f.val);
    }
    if (ctx.orderBy) {
      const { col, opts } = ctx.orderBy;
      rows.sort((a, b) => {
        const cmp = String(a[col]).localeCompare(String(b[col]));
        return opts?.ascending === false ? -cmp : cmp;
      });
    }
    if (typeof ctx.lim === 'number') {
      rows = rows.slice(0, ctx.lim);
    }
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  }

  return {
    from(table: string) {
      const ctx: any = { table, op: '', filters: [], dupOpts: null };
      const builder: any = {
        insert(row: FakeRow) {
          ctx.op = 'insert';
          ctx.insertRow = row;
          return builder;
        },
        upsert(row: FakeRow, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          ctx.op = 'upsert';
          ctx.insertRow = row;
          ctx.dupOpts = opts ?? null;
          return builder;
        },
        select(_cols?: string) {
          if (!ctx.op) ctx.op = 'select';
          return builder;
        },
        eq(col: string, val: unknown) {
          ctx.filters.push({ col, val });
          return builder;
        },
        order(col: string, opts?: unknown) {
          ctx.orderBy = { col, opts };
          return builder;
        },
        limit(n: number) {
          ctx.lim = n;
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(execute(ctx, true));
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(execute(ctx, false)).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function newState(rows: FakeRow[] = []): FakeState {
  return { rows, ops: [], seq: rows.length };
}

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

const samplePayload = {
  status: 'success',
  match: { title: 'Team A vs Team B', meta: 'Анализ на основе исследования открытых источников' },
  probabilities: {
    outcomes: [
      { label: 'Победа Команды 1', value: '52%' },
      { label: 'Ничья', value: '24%' },
      { label: 'Победа Команды 2', value: '24%' },
    ],
    totals: [{ label: 'ТБ 2.5', value: '48%' }],
    btts: [{ label: 'Да', value: '51%' }],
  },
  explanation: { overview: 'oo', team1Form: 'f1', team2Form: 'f2', h2h: 'h', squadAndInjuries: 'i', factors: 'x' },
  usedSources: [{ title: 'UEFA', url: 'https://www.uefa.com/example' }],
};

// ── 1. savePrediction ─────────────────────────────────────────────────────

describe('savePrediction', () => {
  test('inserts the documented fields on the predictions table', async () => {
    const state = newState();
    const client = createFakeClient(state);

    const result = await savePrediction(client, {
      userId: USER_ID,
      matchTitle: '  Team A vs Team B  ',
      payload: samplePayload,
      idempotencyKey: `analysis:${USER_ID}:op:op-aaaaaaaa`,
    });

    assert.deepEqual(result, { ok: true, id: 'pred-1', isDuplicate: false });
    assert.equal(state.ops.length, 1);
    assert.equal(state.ops[0].op, 'upsert');
    assert.equal(state.ops[0].table, 'predictions');
    const row = state.ops[0].row!;
    assert.equal(row.user_id, USER_ID);
    assert.equal(row.sport, 'football');
    assert.equal(row.match_title, 'Team A vs Team B');
    assert.equal(row.idempotency_key, `analysis:${USER_ID}:op:op-aaaaaaaa`);
    assert.deepEqual(row.payload, samplePayload);
  });

  test('replay with the same idempotency key does not create a second row', async () => {
    const state = newState();
    const client = createFakeClient(state);
    const input = {
      userId: USER_ID,
      matchTitle: 'Team A vs Team B',
      payload: samplePayload,
      idempotencyKey: 'analysis:k1',
    };

    const first = await savePrediction(client, input);
    const second = await savePrediction(client, input);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.isDuplicate, false);
      assert.equal(second.isDuplicate, true);
      assert.equal(second.id, first.id);
    }
    assert.equal(state.rows.length, 1);
  });

  test('a conflicting key owned by another row never overwrites it and never returns it', async () => {
    const state = newState([
      {
        id: 'other-1',
        user_id: '11111111-1111-1111-1111-111111111111',
        sport: 'football',
        match_title: 'Other match',
        payload: { marker: 'original' },
        idempotency_key: 'analysis:k1',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const client = createFakeClient(state);

    const result = await savePrediction(client, {
      userId: USER_ID,
      matchTitle: 'Team A vs Team B',
      payload: samplePayload,
      idempotencyKey: 'analysis:k1',
    });

    assert.deepEqual(result, { ok: false, error: 'Конфликт ключа идемпотентности.', status: 409 });
    assert.equal(state.rows.length, 1);
    assert.deepEqual(state.rows[0].payload, { marker: 'original' });
    assert.equal(state.rows[0].match_title, 'Other match');
    assert.equal(state.ops.filter((o) => o.op === 'upsert' || o.op === 'insert').length, 1);
  });

  test('insert failure returns a typed failure and logs diagnostics without payload', async () => {
    const state = newState();
    state.insertError = { code: '42P01', message: 'relation "predictions" does not exist' };
    const client = createFakeClient(state);

    const realErr = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => logged.push(args.map((a) => JSON.stringify(a)).join(' '));
    try {
      const result = await savePrediction(client, {
        userId: USER_ID,
        matchTitle: 'Team A vs Team B',
        payload: samplePayload,
        idempotencyKey: 'analysis:k1',
      });

      assert.deepEqual(result, { ok: false, error: 'Не удалось сохранить прогноз.', status: 500 });
      assert.equal(logged.length, 1);
      assert.match(logged[0], /42P01/);
      assert.doesNotMatch(logged[0], /Победа Команды 1/);
    } finally {
      console.error = realErr;
    }
  });

  test('rejects invalid userId, empty match title and non-object payload', async () => {
    const state = newState();
    const client = createFakeClient(state);

    const badUser = await savePrediction(client, {
      userId: 'not-a-uuid',
      matchTitle: 'Team A vs Team B',
      payload: samplePayload,
      idempotencyKey: 'k',
    });
    assert.equal(badUser.ok, false);

    const badTitle = await savePrediction(client, {
      userId: USER_ID,
      matchTitle: '   ',
      payload: samplePayload,
      idempotencyKey: 'k',
    });
    assert.equal(badTitle.ok, false);

    const badPayload = await savePrediction(client, {
      userId: USER_ID,
      matchTitle: 'Team A vs Team B',
      payload: [] as unknown as Record<string, unknown>,
      idempotencyKey: 'k',
    });
    assert.equal(badPayload.ok, false);

    assert.equal(state.ops.length, 0);
  });
});

// ── 2. listPredictions ────────────────────────────────────────────────────

describe('listPredictions', () => {
  test('filters by user_id, orders newest first and honours the limit', async () => {
    const state = newState([
      {
        id: 'p1',
        user_id: USER_ID,
        sport: 'football',
        match_title: 'Old',
        payload: {},
        idempotency_key: 'k1',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'p2',
        user_id: '22222222-2222-2222-2222-222222222222',
        sport: 'football',
        match_title: 'Foreign',
        payload: {},
        idempotency_key: 'k2',
        created_at: '2026-03-01T00:00:00.000Z',
      },
      {
        id: 'p3',
        user_id: USER_ID,
        sport: 'football',
        match_title: 'Newest',
        payload: {},
        idempotency_key: 'k3',
        created_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
    const client = createFakeClient(state);

    const result = await listPredictions(client, USER_ID, 1);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.predictions.length, 1);
      assert.equal(result.predictions[0].id, 'p3');
    }
    const selectOp = state.ops.find((o) => o.op === 'select')!;
    assert.deepEqual(selectOp.filters, [{ col: 'user_id', val: USER_ID }]);
  });

  test('returns a typed failure when the query fails', async () => {
    const state = newState();
    state.selectError = { code: '42P01', message: 'relation "predictions" does not exist' };
    const client = createFakeClient(state);

    const realErr = console.error;
    console.error = () => {};
    try {
      const result = await listPredictions(client, USER_ID, 20);
      assert.deepEqual(result, {
        ok: false,
        error: 'Ошибка при получении истории прогнозов.',
        status: 500,
      });
    } finally {
      console.error = realErr;
    }
  });
});

// ── 3. migration contract (static) ────────────────────────────────────────

describe('migration 20261023000000: predictions table contract (static)', () => {
  const sql = readFileSync(
    path.join(process.cwd(), 'supabase', 'migrations', '20261023000000_predictions.sql'),
    'utf8',
  );

  test('declares the required columns and constraints', () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.predictions/);
    assert.match(sql, /id\s+uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    assert.match(sql, /user_id\s+uuid\s+NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    assert.match(sql, /sport\s+text\s+NOT NULL DEFAULT 'football'/);
    assert.match(sql, /CHECK \(sport = 'football'\)/);
    assert.match(sql, /match_title\s+text\s+NOT NULL/);
    assert.match(sql, /payload\s+jsonb\s+NOT NULL/);
    assert.match(sql, /idempotency_key\s+text\s+NOT NULL/);
    assert.match(sql, /created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
  });

  test('has a unique idempotency index and a user/time index', () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_idempotency\s+ON public\.predictions \(idempotency_key\)/,
    );
    assert.match(
      sql,
      /CREATE INDEX IF NOT EXISTS idx_predictions_user_time\s+ON public\.predictions \(user_id, created_at DESC\)/,
    );
  });

  test('enables RLS with own-rows SELECT for authenticated and full access for service_role', () => {
    assert.match(sql, /ALTER TABLE public\.predictions ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /CREATE POLICY predictions_select_own[\s\S]*?FOR SELECT[\s\S]*?TO authenticated[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
    assert.match(sql, /CREATE POLICY predictions_service_all[\s\S]*?FOR ALL[\s\S]*?TO service_role[\s\S]*?USING \(true\) WITH CHECK \(true\)/);
  });

  test('revokes anon completely and grants authenticated SELECT only', () => {
    assert.match(sql, /REVOKE ALL ON public\.predictions FROM anon, authenticated/);
    assert.match(sql, /GRANT SELECT ON public\.predictions TO authenticated/);
    assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.predictions TO (anon|authenticated)/);
  });
});

// ── 4. route integration (real POST /api/analyze) ─────────────────────────

type FetchCall = { url: string; method: string; body?: string };

function makeMockFetch(reportText: string, llmBody: string, calls: FetchCall[]) {
  return (async (url: any, init?: any) => {
    const u = String(url);
    const method = String(init?.method || 'GET');
    calls.push({ url: u, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (u === 'https://api.you.com/v1/research' && method === 'POST') {
      return new Response(JSON.stringify({ task_id: 'task-history-test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.startsWith('https://api.you.com/v1/research/')) {
      return new Response(
        JSON.stringify({
          status: 'completed',
          result: { content: reportText },
          sources: [{ title: 'UEFA', url: 'https://www.uefa.com/example' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u === 'https://api.keydealer.ru/v1/chat/completions') {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: llmBody } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error('unexpected fetch in test: ' + u);
  }) as typeof fetch;
}

describe('POST /api/analyze: prediction history side effects', () => {
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  const realLog = console.log;
  const realWarn = console.warn;

  let calls: FetchCall[];
  let saveCalls: Array<Record<string, unknown>>;
  let saveResult: { ok: true; id: string; isDuplicate: boolean } | { ok: false; error: string; status: number };
  let consumeSuccess: boolean;
  let requestedSid: string;

  beforeEach(() => {
    calls = [];
    saveCalls = [];
    saveResult = { ok: true, id: 'pred-1', isDuplicate: false };
    consumeSuccess = true;
    requestedSid = 'sid-history-1';
    clearResearchCacheForTests();
    process.env.YDC_API_KEY = 'ydc_live_p0test';
    process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-history';
    process.env.ANALYSIS_COST = '10';
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};

    mock.module('@/lib/supabase/predictions', {
      namedExports: {
        savePrediction: async (_client: any, input: any) => {
          saveCalls.push(input);
          return saveResult;
        },
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    delete process.env.YDC_API_KEY;
    delete process.env.KEYDEALER_API_KEY;
    delete process.env.ANON_SESSION_SECRET;
    delete process.env.ANALYSIS_COST;
    mock.restoreAll();
  });

  function makeRequest(body: unknown): Request {
    return new Request('http://localhost/api/analyze', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', cookie: `anon_sid=${requestedSid}` },
    });
  }

  async function loadRouteWithMocks(userId: string | null, freeAllowed = false) {
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () =>
          freeAllowed ? { allowed: true, reservationId: 'free-res-1' } : { allowed: false, reason: 'limit_exhausted' },
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => ({
          get: (name: string) =>
            name === 'anon_sid' ? { name, value: requestedSid } : undefined,
          set: () => {},
          has: () => true,
          delete: () => {},
          getAll: () => [{ name: 'anon_sid', value: requestedSid }],
          keys: () => ['anon_sid'],
        }),
      },
    });
    mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
    mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
    mock.module('@/lib/auth/session', {
      namedExports: {
        getCurrentSession: async () =>
          userId ? { ok: true, user: { id: userId, email: 'a@b' } } : { ok: false, error: 'no session' },
      },
    });
    mock.module('@/lib/supabase/credits', {
      namedExports: {
        reserveCreditSpend: async () => ({ ok: true, reservationId: 'cr-history' }),
        consumeCreditSpend: async () => (consumeSuccess ? { success: true } : { success: false }),
        releaseCreditSpend: async () => ({ released: true }),
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const mod = await import(`../src/app/api/analyze/route?cb=${bust}`);
    return mod.POST;
  }

  test('saves the final football payload for the authenticated user after a confirmed consume', async () => {
    const POST = await loadRouteWithMocks('u-history');
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B', operationId: 'op-history-01' }));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(saveCalls.length, 1);
    const saved = saveCalls[0];
    assert.equal(saved.userId, 'u-history');
    assert.equal(saved.sport, 'football');
    assert.equal(saved.matchTitle, body.match.title);
    assert.equal(saved.idempotencyKey, 'analysis:u-history:op:op-history-01');
    assert.deepEqual(saved.payload, body);
  });

  test('does not save history when consumeCreditSpend fails', async () => {
    consumeSuccess = false;
    const POST = await loadRouteWithMocks('u-history');
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B', operationId: 'op-history-02' }));

    assert.equal(res.status, 500);
    assert.equal(saveCalls.length, 0);
  });

  test('a failed history write does not change the successful public response', async () => {
    saveResult = { ok: false, error: 'Не удалось сохранить прогноз.', status: 500 };
    const POST = await loadRouteWithMocks('u-history');
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B', operationId: 'op-history-03' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), [
      'explanation',
      'match',
      'probabilities',
      'status',
      'usedSources',
    ]);
    assert.equal(body.status, 'success');
    assert.equal(saveCalls.length, 1);
  });

  test('anonymous free path never writes history even on success', async () => {
    const POST = await loadRouteWithMocks(null, true);
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    assert.equal(saveCalls.length, 0);
  });

  test('exhausted free limit on the anonymous path writes no history', async () => {
    const POST = await loadRouteWithMocks(null, false);
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 402, 'exhausted free limit is declined before any history write');
    assert.equal(saveCalls.length, 0);
  });
});

// ── 5. hockey branch is untouched (static) ────────────────────────────────

describe('hockey branch isolation (static)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'app', 'api', 'analyze', 'route.ts'),
    'utf8',
  );

  test('savePrediction is never referenced inside handleHockeyAnalysis', () => {
    const start = source.indexOf('async function handleHockeyAnalysis');
    assert.ok(start > 0, 'handleHockeyAnalysis must exist');
    const end = source.indexOf('export async function POST', start);
    assert.ok(end > start);
    const hockeyBody = source.slice(start, end);
    assert.doesNotMatch(hockeyBody, /savePrediction|predictions/);
  });

  test('history is written exactly once, inside the credit-spend block', () => {
    const occurrences = source.match(/savePrediction\(/g) ?? [];
    assert.equal(occurrences.length, 1);
    const at = source.indexOf('savePrediction(');
    const consumeAt = source.indexOf('await consumeCreditSpend(');
    const responseAt = source.lastIndexOf('return NextResponse.json(response);');
    assert.ok(consumeAt > 0, 'consume call must exist');
    assert.ok(at > consumeAt, 'history write must happen after a confirmed consume');
    assert.ok(at < responseAt, 'history write must happen before the success response');
  });
});

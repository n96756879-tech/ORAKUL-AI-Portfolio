// P0-регрессионные тесты контракта releaseFreeGeneration.
// Supabase не используется: мок только createClient (postgrest-like цепочка),
// поэтому исполняется реальная логика src/lib/supabase/free-limit.ts.
// Ключи/сеть/.env не используются; значения env — фиктивные тестовые строки.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const ENV_URL = 'NEXT_PUBLIC_SUPABASE_URL';
const ENV_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

type DeleteOutcome = { error: unknown; count: number | null } | Error;

let deleteOutcome: DeleteOutcome;
let updateOutcome: { error: unknown; count: number | null } | undefined;
let clientCreated = 0;

function fakeClient() {
  const builder: any = {
    delete: (_opts?: unknown) => {
      return builder;
    },
    update: (_values?: unknown, _opts?: unknown) => {
      return builder;
    },
    eq: () => builder,
    then: (resolve: any, reject: any) => {
      const outcome = updateOutcome === undefined ? deleteOutcome : updateOutcome;
      if (outcome instanceof Error) {
        return Promise.reject(outcome).then(resolve, reject);
      }
      return Promise.resolve(outcome).then(resolve, reject);
    },
  };
  return { from: () => builder };
}

async function loadRelease() {
  const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
  return import(`../src/lib/supabase/free-limit.ts?cb=${bust}`);
}

describe('releaseFreeGeneration contract', () => {
  const savedUrl = process.env[ENV_URL];
  const savedKey = process.env[ENV_KEY];

  beforeEach(() => {
    clientCreated = 0;
    deleteOutcome = { error: null, count: 1 };
    updateOutcome = undefined;
    mock.module('@supabase/supabase-js', {
      namedExports: {
        createClient: () => {
          clientCreated += 1;
          return fakeClient();
        },
      },
    });
  });

  afterEach(() => {
    mock.restoreAll();
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
  });

  test('reports confirmed deletion of exactly one row', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    deleteOutcome = { error: null, count: 1 };

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-1');

    assert.deepEqual(result, { released: true, deletedCount: 1 });
    assert.equal(clientCreated, 1);
  });

  test('reports zero deleted rows as not_found', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    deleteOutcome = { error: null, count: 0 };

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-missing');

    assert.deepEqual(result, { released: false, reason: 'not_found' });
  });

  test('reports a Supabase error as db_error', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    deleteOutcome = { error: { code: 'XX000', message: 'boom' }, count: null };

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-err');

    assert.deepEqual(result, { released: false, reason: 'db_error' });
  });

  test('reports a thrown transport error as unknown', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    deleteOutcome = new Error('network down');

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-throw');

    assert.deepEqual(result, { released: false, reason: 'unknown' });
  });

  test('reports missing configuration as not_configured without a client', async () => {
    delete process.env[ENV_URL];
    delete process.env[ENV_KEY];

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-noconfig');

    assert.deepEqual(result, { released: false, reason: 'not_configured' });
    assert.equal(clientCreated, 0);
  });

  test('reports an unexpected row count as unknown', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    deleteOutcome = { error: null, count: 2 };

    const { releaseFreeGeneration } = await loadRelease();
    const result = await releaseFreeGeneration('res-weird');

    assert.deepEqual(result, { released: false, reason: 'unknown' });
  });
});

describe('consumeFreeGeneration contract', () => {
  const savedUrl = process.env[ENV_URL];
  const savedKey = process.env[ENV_KEY];

  beforeEach(() => {
    clientCreated = 0;
    deleteOutcome = { error: null, count: 1 };
    updateOutcome = { error: null, count: 1 };
    mock.module('@supabase/supabase-js', {
      namedExports: {
        createClient: () => {
          clientCreated += 1;
          return fakeClient();
        },
      },
    });
  });

  afterEach(() => {
    mock.restoreAll();
    if (savedUrl === undefined) delete process.env[ENV_URL];
    else process.env[ENV_URL] = savedUrl;
    if (savedKey === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedKey;
  });

  test('reports success when exactly one row is consumed', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    updateOutcome = { error: null, count: 1 };

    const { consumeFreeGeneration } = await loadRelease();
    const result = await consumeFreeGeneration('res-1');

    assert.deepEqual(result, { success: true });
    assert.equal(clientCreated, 1);
  });

  test('reports failure when count is zero', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    updateOutcome = { error: null, count: 0 };

    const { consumeFreeGeneration } = await loadRelease();
    const result = await consumeFreeGeneration('res-missing');

    assert.deepEqual(result, { success: false });
  });

  test('reports failure when count is null', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    updateOutcome = { error: null, count: null };

    const { consumeFreeGeneration } = await loadRelease();
    const result = await consumeFreeGeneration('res-null');

    assert.deepEqual(result, { success: false });
  });

  test('reports failure when count is undefined', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    updateOutcome = { error: null, count: undefined as unknown as number | null };

    const { consumeFreeGeneration } = await loadRelease();
    const result = await consumeFreeGeneration('res-undefined');

    assert.deepEqual(result, { success: false });
  });

  test('reports failure on a Supabase error', async () => {
    process.env[ENV_URL] = 'https://test.supabase.co';
    process.env[ENV_KEY] = 'test-service-role-key';
    updateOutcome = { error: { code: 'XX000', message: 'boom' }, count: null };

    const { consumeFreeGeneration } = await loadRelease();
    const result = await consumeFreeGeneration('res-err');

    assert.deepEqual(result, { success: false });
  });
});

// STEP 9: regression-тесты интеграции DAL за feature flag ORAKUL_DAL_ENABLED.
// Сеть полностью замокана (globalThis.fetch): You.com init+poll, KeyDealer chat.
// Реальные API, .env и ключи не используются. DAL работает без fetchers (только cache).
// NOTE: we do NOT import { POST } statically — we dynamically import it AFTER mock.module in beforeEach to ensure the mock intercepts the free-limit import inside route.ts.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { buildMatchCacheKey, getSharedDataPackCache, matchQueryFromFreeForm } from '../src/lib/data/resolver';
import type { DataPack, ProvenancedEntry } from '../src/lib/data/types';
import { clearResearchCacheForTests } from '../src/lib/data/research-cache';
import {
  buildFullVdp,
  buildResearchReportWithVdp,
  buildLlmContractResponse,
} from './helpers/fixtures';

// Dynamically assigned after beforeEach mock + import
let POST: any;

type FetchCall = { url: string; method: string };

function makeMockFetch(reportText: string, llmBody: string, calls: FetchCall[]) {
  return (async (url: unknown, init?: unknown) => {
    const u = String(url);
    const method = String((init as { method?: string } | undefined)?.method || 'GET');
    calls.push({ url: u, method });
    if (u === 'https://api.you.com/v1/research' && method === 'POST') {
      return new Response(JSON.stringify({ task_id: 'task-dal-test' }), {
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
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u === 'https://api.keydealer.ru/v1/chat/completions') {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: llmBody } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error('unexpected fetch in test: ' + u);
  }) as typeof fetch;
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function confirmedFormEntry(team: string): ProvenancedEntry<DataPack['form'][number]['data']> {
  return {
    data: { team, summary: 'W W D L W' },
    confirmed: true,
    confidence: 0.9,
    sourceId: 'test-src',
    fetchedAt: '2026-09-27T00:00:00Z',
  };
}

function seededPartialPack(): DataPack {
  return {
    fixture: null,
    form: [confirmedFormEntry('Team A'), confirmedFormEntry('Team B')],
    h2h: [],
    squads: [],
    injuries: [],
    sources: [],
    freshness: {},
    conflicts: [],
    status: 'partial',
  };
}

// Ключ строится тем же production-кодом, что и внутри route.ts.
function expectedCacheKey(): string {
  return buildMatchCacheKey(matchQueryFromFreeForm('Team A vs Team B'));
}

describe('STEP 9: DAL integration behind ORAKUL_DAL_ENABLED', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;

  beforeEach(async () => {
    calls = [];
    clearResearchCacheForTests();
    process.env.YDC_API_KEY = 'ydc_live_p0test';
    process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-dal';
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    // IMPORTANT: mock BEFORE dynamic import of the route module so that route.ts sees the mocked free-limit and next/headers mocks
    // Use namedExports to satisfy current @types/node; runtime will show deprecation but still mock correctly.
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => ({
          get: async (name: string) => ({ name, value: 'dal-test-sid' }),
          set: async () => {},
          has: async () => true,
          delete: async () => {},
          getAll: async () => [{ name: 'anon_sid', value: 'dal-test-sid' }],
          keys: async () => ['anon_sid'],
        }),
      },
    });
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-dal' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    // Dynamically import AFTER the mock is in place — this ensures production route.ts loads the mock
    const mod = await import('../src/app/api/analyze/route');
    POST = mod.POST;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.YDC_API_KEY;
    delete process.env.KEYDEALER_API_KEY;
    delete process.env.ANON_SESSION_SECRET;
    delete process.env.ORAKUL_DAL_ENABLED;
    getSharedDataPackCache().clear();
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    mock.restoreAll();
  });

  test('S1: флаг отсутствует → DAL bypass, pipeline как раньше', async () => {
    delete process.env.ORAKUL_DAL_ENABLED;
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);

    const cache = getSharedDataPackCache();
    assert.equal(cache.get(expectedCacheKey()), null, 'DAL не должен был писать в кэш');

    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.ok(calls.some((c) => c.url === 'https://api.keydealer.ru/v1/chat/completions'));
  });

  test('S2: ORAKUL_DAL_ENABLED="false" → DAL bypass', async () => {
    process.env.ORAKUL_DAL_ENABLED = 'false';
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    assert.equal(getSharedDataPackCache().get(expectedCacheKey()), null);
  });

  test('S3: флаг включён + пустой DataPack → 200, без fake data, pipeline работает', async () => {
    process.env.ORAKUL_DAL_ENABLED = 'true';
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200, 'пустой DAL не должен ломать pipeline');

    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.ok(Array.isArray(body.probabilities?.outcomes));
    // Полный сетевой флоу сохранился: You.com init + poll + KeyDealer.
    assert.ok(calls.some((c) => c.url === 'https://api.you.com/v1/research' && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.startsWith('https://api.you.com/v1/research/')));
    assert.ok(calls.some((c) => c.url === 'https://api.keydealer.ru/v1/chat/completions'));
    // DAL отработал: DataPack закэширован (пустой, без выдуманных данных).
    const cached = getSharedDataPackCache().get(expectedCacheKey());
    assert.ok(cached, 'DataPack должен быть закэширован при включённом DAL');
    assert.equal(cached?.fixture, null);
    assert.equal(cached?.form.length, 0);
    assert.equal(cached?.status, 'empty');
  });

  test('S4: флаг включён + partial DataPack в кэше → контекст создан, You.com VDP pipeline цел', async () => {
    process.env.ORAKUL_DAL_ENABLED = 'true';
    // Предзаполняем кэш — resolver обязан вернуть cacheHit с этим DataPack.
    getSharedDataPackCache().set(expectedCacheKey(), seededPartialPack());

    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.status, 'success');
    // You.com VDP pipeline отработал полностью: engine+LLM+A1 не задеты.
    assert.ok(calls.some((c) => c.url === 'https://api.keydealer.ru/v1/chat/completions'));
    // Числа в ответе — от engine (см. S5/A1-тест), структура контракта прежняя.
    assert.match(String(body.probabilities.outcomes[0].value), /^\d+%$/);
  });

  test('S5: A1 authoritative — финальные числа от engine, не от LLM', async () => {
    process.env.ORAKUL_DAL_ENABLED = 'true';
    const report = buildResearchReportWithVdp(buildFullVdp());
    // LLM возвращает «свои» вероятности (42/16/42) — они не должны пройти в ответ.
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 42, draw: 16, team2: 42 }), calls);

    // Реальный engine на buildFullVdp() даёт детерминированный результат (см. T7).
    // Считаем его напрямую тем же production-кодом и сравниваем с ответом API.
    const { parseVDP } = await import('../src/lib/vdp-parser');
    const { calculateProbabilities } = await import('../src/lib/probability-engine');
    const engine = calculateProbabilities(parseVDP(buildFullVdp()));

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const values = body.probabilities.outcomes.map((o: { value: string }) => o.value);
    assert.deepEqual(values, [`${engine.team1}%`, `${engine.draw}%`, `${engine.team2}%`]);
    assert.notDeepEqual(values, ['42%', '16%', '42%']);
  });
});

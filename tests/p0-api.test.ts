// P0-регрессионные тесты API /api/analyze (Tests 11–12) — текущее поведение.
// Сеть полностью замокана (globalThis.fetch): You.com init+poll, KeyDealer chat.
// Реальные вызовы, .env, YDC_API_KEY/KEYDEALER_API_KEY не используются.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/analyze/route';
import {
  buildFullVdp,
  buildResearchReportWithVdp,
  buildLlmContractResponse,
} from './helpers/fixtures';
import { clearResearchCacheForTests } from '../src/lib/data/research-cache';

type FetchCall = { url: string; method: string };

function makeMockFetch(reportText: string, llmBody: string, calls: FetchCall[]) {
  return (async (url: any, init?: any) => {
    const u = String(url);
    const method = String(init?.method || 'GET');
    calls.push({ url: u, method });
    if (u === 'https://api.you.com/v1/research' && method === 'POST') {
      return new Response(JSON.stringify({ task_id: 'task-p0-test' }), {
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

describe('P0 API /api/analyze (current behavior)', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;

  beforeEach(() => {
    calls = [];
    clearResearchCacheForTests();
    // Изолируем от реального окружения: только тестовые ключи, никакого .env
    process.env.YDC_API_KEY = 'ydc_live_p0test';
    process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
    // route.ts пишет большие diagnostic-логи — гасим на время теста
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.YDC_API_KEY;
    delete process.env.KEYDEALER_API_KEY;
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
  });

  test('T11: report without VERIFIED DATA PACK marker — 422', async () => {
    globalThis.fetch = makeMockFetch(
      'Some research text without any verified data pack marker.',
      buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }),
      calls
    );
    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(String(body.error).includes('VERIFIED DATA PACK'));
    // LLM не должен был вызваться
    assert.ok(!calls.some((c) => c.url.includes('keydealer')));
  });

  test('T11b: VDP present but insufficient data — 422', async () => {
    // VDP с маркером, но без матчей и без H2H -> insufficient
    const vdpOnlyNames = `# RESEARCH REPORT — VERIFIED DATA PACK

## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

## TEAM 2 FORM
`;
    globalThis.fetch = makeMockFetch(
      vdpOnlyNames,
      buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }),
      calls
    );
    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(String(body.error).includes('недостаточно данных'));
    assert.ok(!calls.some((c) => c.url.includes('keydealer')));
  });

  test('T11c: missing match field — 400', async () => {
    globalThis.fetch = makeMockFetch('', '', calls);
    const res = await POST(makeRequest({}));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(String(body.error).includes('матч'));
    assert.equal(calls.length, 0);
  });

  test('T12: valid VDP + valid LLM contract — 200 with probabilities', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    const llmProbabilities = { team1: 45, draw: 25, team2: 30 };
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse(llmProbabilities), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();

    // Был полный сетевой флоу: You.com init + poll + KeyDealer
    assert.ok(calls.some((c) => c.url === 'https://api.you.com/v1/research' && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.startsWith('https://api.you.com/v1/research/')));
    assert.ok(calls.some((c) => c.url === 'https://api.keydealer.ru/v1/chat/completions'));

    // Контракт ответа (текущая форма адаптера)
    assert.ok(body && typeof body === 'object');
    assert.equal(body.status, 'success');
    assert.ok(body.match, 'response must contain match');
    assert.ok(Array.isArray(body.probabilities?.outcomes), 'probabilities.outcomes must be array');
    assert.equal(body.probabilities.outcomes.length, 3);
    for (const outcome of body.probabilities.outcomes) {
      assert.ok(outcome.label, 'outcome must have label');
      assert.match(String(outcome.value), /^\d+%$/, 'outcome value must be percent string');
    }
    assert.ok(body.explanation, 'response must contain explanation');
    assert.ok(Array.isArray(body.usedSources), 'response must contain usedSources array');
  });
});

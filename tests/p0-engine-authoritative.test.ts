// A1 regression: Probability Engine — единственный источник числовых вероятностей.
// LLM отвечает только за текстовый анализ; числа из LLM не могут заменить числа Engine.
// Сеть полностью замокана (globalThis.fetch). Реальные API не вызываются.
//
// Тест изолирует contract-логику: calculateProbabilities() замокан ТОЛЬКО внутри теста,
// чтобы задать контролируемый сценарий (Engine 38/17/45 против LLM 42/16/42).
// Production Probability Engine не изменяется.
//
// Запускается с --experimental-test-module-mocks (см. package.json test:p0).
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
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
      return new Response(JSON.stringify({ task_id: 'task-a1-test' }), {
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

describe('A1: engine probabilities remain authoritative over LLM probabilities', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;

  beforeEach(() => {
    clearResearchCacheForTests();
    calls = [];
    process.env.YDC_API_KEY = 'ydc_live_a1test';
    process.env.KEYDEALER_API_KEY = 'kd_live_a1test';
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
  });

  afterEach(() => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    delete process.env.YDC_API_KEY;
    delete process.env.KEYDEALER_API_KEY;
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
  });

  test('engine 38/17/45 + LLM 42/16/42 -> final 38/17/45', async () => {
    // Engine — authoritative числа. Мок только на время этого теста.
    mock.module('@/lib/probability-engine', {
      namedExports: {
        calculateProbabilities: () => ({ team1: 38, draw: 17, team2: 45 }),
        calculateProbabilitiesWithTrace: () => ({
          result: { team1: 38, draw: 17, team2: 45 },
          trace: {} as any,
        }),
      },
    });

    const { POST } = await import('../src/app/api/analyze/route');

    const report = buildResearchReportWithVdp(buildFullVdp());
    // LLM намеренно возвращает ДРУГИЕ числа (42/16/42), сумма 100 — контракт валиден.
    const llmBody = buildLlmContractResponse({ team1: 42, draw: 16, team2: 42 });
    globalThis.fetch = makeMockFetch(report, llmBody, calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);

    const body = await res.json();

    // Был вызван LLM (KeyDealer) — значит расхождение реально создано.
    assert.ok(calls.some((c) => c.url === 'https://api.keydealer.ru/v1/chat/completions'));

    const values = body.probabilities.outcomes.map((o: any) => o.value);
    assert.deepEqual(values, ['38%', '17%', '45%']);
    // Значения LLM не смогли заменить значения Engine.
    assert.notDeepEqual(values, ['42%', '16%', '42%']);
  });
});

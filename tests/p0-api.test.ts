// P0-регрессионные тесты API /api/analyze (Tests 11–12) — текущее поведение.
// Сеть полностью замокана (globalThis.fetch): You.com init+poll, KeyDealer chat.
// Реальные вызовы, .env, YDC_API_KEY/KEYDEALER_API_KEY не используются.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POST, buildGoalDistributionInput } from '../src/app/api/analyze/route';
import { parseVDP } from '../src/lib/vdp-parser';
import { calculateGoalDistribution } from '../src/lib/goal-distribution';
import {
  buildFullVdp,
  buildResearchReportWithVdp,
  buildLlmContractResponse,
} from './helpers/fixtures';
import { clearResearchCacheForTests } from '../src/lib/data/research-cache';

type FetchCall = { url: string; method: string; body?: string };

function makeMockFetch(
  reportText: string,
  llmBody: string | string[],
  calls: FetchCall[],
  llmStatus = 200,
) {
  const llmBodies = Array.isArray(llmBody) ? llmBody : [llmBody];
  let llmCallIndex = 0;
  return (async (url: any, init?: any) => {
    const u = String(url);
    const method = String(init?.method || 'GET');
    calls.push({ url: u, method, body: typeof init?.body === 'string' ? init.body : undefined });
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
      const body = llmBodies[Math.min(llmCallIndex, llmBodies.length - 1)];
      llmCallIndex += 1;
      if (llmStatus !== 200) {
        return new Response('provider error', { status: llmStatus });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: body } }] }),
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
  let logs: string[];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;

  beforeEach(() => {
    calls = [];
    logs = [];
    clearResearchCacheForTests();
    // Изолируем от реального окружения: только тестовые ключи, никакого .env
    process.env.YDC_API_KEY = 'ydc_live_p0test';
    process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
    // route.ts пишет большие diagnostic-логи — гасим на время теста
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
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

  test('T13: production route calls Goal Distribution and keeps A1 response authoritative', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution:')));
    assert.deepEqual(
      body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value),
      ['48%', '19%', '33%'],
    );
    assert.notDeepEqual(
      body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value),
      ['42%', '16%', '42%'],
    );
  });

  test('T14: Goal Distribution mapper preserves parsed match data and does not mutate VDP', () => {
    const parsed = parseVDP(buildFullVdp());
    const before = structuredClone(parsed);
    const input = buildGoalDistributionInput(parsed);

    assert.deepEqual(parsed, before);
    assert.deepEqual(input.team1.matches[0], {
      goalsFor: parsed.team1.matches[0].goalsFor,
      goalsAgainst: parsed.team1.matches[0].goalsAgainst,
      result: parsed.team1.matches[0].result,
      opponentStrength: parsed.team1.matches[0].opponentStrength,
      venue: parsed.team1.matches[0].venue,
    });
    // D-29: currentVenue прокидывается из ParsedVDP (team1) и зеркалится для team2.
    assert.equal(input.team1.currentVenue, parsed.currentVenue);
    assert.equal('futureOpponentStrength' in input.team1, false);
    assert.equal('futureOpponentStrength' in input.team2, false);
  });

  test('T14b (F): buildGoalDistributionInput зеркалит currentVenue для team2', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** A vs B; A home, B away.

## TEAM 1 FORM
- **FACT:** A

## TEAM 2 FORM
- **FACT:** B
`);
    assert.equal(parsed.currentVenue, 'HOME');
    const home = buildGoalDistributionInput(parsed);
    assert.equal(home.team1.currentVenue, 'HOME');
    assert.equal(home.team2.currentVenue, 'AWAY');

    const away = buildGoalDistributionInput({ ...parsed, currentVenue: 'AWAY' });
    assert.equal(away.team1.currentVenue, 'AWAY');
    assert.equal(away.team2.currentVenue, 'HOME');

    const unknown = buildGoalDistributionInput({ ...parsed, currentVenue: 'UNKNOWN' });
    assert.equal(unknown.team1.currentVenue, 'UNKNOWN');
    assert.equal(unknown.team2.currentVenue, 'UNKNOWN');
  });

  test('T14c (F): GD получает currentVenue и не включает venue-fallback при валидном currentVenue', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** A vs B; A home, B away.

## TEAM 1 FORM
- **FACT:** A

### MATCH 1
- **DATE:** 2026-09-20
- **OPPONENT:** O
- **HOME/AWAY:** HOME
- **SCORE:** 3-0
- **RESULT:** W

### MATCH 2
- **DATE:** 2026-09-13
- **OPPONENT:** P
- **HOME/AWAY:** HOME
- **SCORE:** 2-0
- **RESULT:** W

## TEAM 2 FORM
- **FACT:** B
`);
    assert.equal(parsed.currentVenue, 'HOME');
    const gd = calculateGoalDistribution(buildGoalDistributionInput(parsed));
    assert.equal(gd.diagnostics.usedFallbacks.includes('team1-venue'), false);
    assert.equal(gd.diagnostics.usedFallbacks.includes('team2-venue'), true);
  });

  test('T15: cache HIT skips Research while Goal Distribution remains local', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);
    assert.equal((await POST(makeRequest({ match: 'Team A vs Team B' }))).status, 200);

    calls.length = 0;
    logs = [];
    assert.equal((await POST(makeRequest({ match: 'Team A vs Team B' }))).status, 200);
    assert.equal(calls.filter((call) => call.url.includes('api.you.com')).length, 0);
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution:')));
  });

  test('T16: LLM receives production Goal Distribution values and public response stays compatible', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 99, draw: 1, team2: 0 }), calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);

    const llmCall = calls.find((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions');
    assert.ok(llmCall?.body, 'LLM request body must be captured');
    const payload = JSON.parse(llmCall.body);
    const userMessage = payload.messages.find((message: { role: string }) => message.role === 'user').content;
    const goalDistribution = calculateGoalDistribution(
      buildGoalDistributionInput(parseVDP(buildFullVdp())),
    );
    const marker = 'GOAL DISTRIBUTION (рассчитано production engine):\n';
    const goalJsonStart = userMessage.indexOf(marker) + marker.length;
    const goalJsonEnd = userMessage.indexOf('\n\nЗначения Goal Distribution', goalJsonStart);
    assert.ok(goalJsonStart > marker.length, 'LLM prompt must include Goal Distribution data');
    const promptGoalDistribution = JSON.parse(userMessage.slice(goalJsonStart, goalJsonEnd));
    assert.deepEqual(promptGoalDistribution, {
      lambda1: goalDistribution.lambda1,
      lambda2: goalDistribution.lambda2,
      markets: {
        result: goalDistribution.markets.result,
        doubleChance: goalDistribution.markets.doubleChance,
        totals: goalDistribution.markets.totals,
        btts: goalDistribution.markets.btts,
        teamScoring: goalDistribution.markets.teamScoring,
      },
    });
    assert.match(userMessage, /derived markets/);
    assert.match(userMessage, /production engine/);
    assert.match(userMessage, /Не пересчитывай, не изменяй и не заменяй/);

    const body = await res.json();
    assert.equal(body.probabilities.outcomes.length, 3);
    assert.deepEqual(
      body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value),
      ['48%', '19%', '33%'],
    );
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Probability Engine: team1=48 draw=19 team2=33')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution markets:')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] LLM Contract probabilities: team1=99 draw=1 team2=0')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Engine vs LLM: engine=48/19/33 llm=99/1/0 match=false')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] A1 final probabilities: team1=48 draw=19 team2=33')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] A1 vs Engine: engine=48/19/33 a1=48/19/33 match=true')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Public Response probabilities: team1=48 draw=19 team2=33')));
  });

  test('T17: valid JSON does not retry', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    assert.equal((await POST(makeRequest({ match: 'Team A vs Team B' }))).status, 200);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 1);
  });

  test('T18: malformed JSON retries once and succeeds without repeating Research', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(
      report,
      ['{"status":"success","match":"Россия — Иран","explanation":{"factors":["обрезано...', buildLlmContractResponse({ team1: 99, draw: 1, team2: 0 })],
      calls,
    );

    const res = await POST(makeRequest({ match: 'Россия — Иран' }));
    assert.equal(res.status, 200);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 2);
    assert.equal(calls.filter((call) => call.url.includes('api.you.com')).length, 2);
    assert.ok(logs.some((line) => line.includes('[LLM] JSON parse failed, retrying once')));
    assert.ok(logs.some((line) => line.includes('[LLM] JSON retry succeeded')));
    const body = await res.json();
    assert.deepEqual(body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value), ['48%', '19%', '33%']);
  });

  test('T19: malformed JSON twice returns existing 502 error', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    const malformed = '{"status":"success","explanation":{"factors":["обрезано...';
    globalThis.fetch = makeMockFetch(report, [malformed, malformed], calls);

    const res = await POST(makeRequest({ match: 'Россия — Иран' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'LLM response was not valid JSON.' });
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 2);
    assert.ok(logs.some((line) => line.includes('[LLM] JSON retry failed')));
  });

  test('T20: HTTP error does not retry JSON parsing', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls, 500);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 502);
    assert.match(String((await res.json()).error), /HTTP 500/);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 1);
  });

  test('T20b: missing content does not retry JSON parsing', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, '', calls);

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'LLM response was not valid JSON.' });
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 1);
  });

  test('T21: retry response cannot replace authoritative Engine probabilities', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(
      report,
      ['{"status":"success","explanation":{"factors":["обрезано...', buildLlmContractResponse({ team1: 99, draw: 1, team2: 0 })],
      calls,
    );

    const res = await POST(makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value), ['48%', '19%', '33%']);
  });
});

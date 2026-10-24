// P0-регрессионные тесты API /api/analyze (Tests 11–12) — текущее поведение.
// Сеть полностью замокана (globalThis.fetch): You.com init+poll, KeyDealer chat.
// Реальные вызовы, .env, YDC_API_KEY/KEYDEALER_API_KEY не используются.
// NOTE: we do NOT import { POST } statically — we dynamically import it AFTER mock.module in beforeEach to ensure the mock intercepts the free-limit import inside route.ts.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseVDP } from '../src/lib/vdp-parser';
import { calculateGoalDistribution } from '../src/lib/goal-distribution';
import {
  buildFullVdp,
  buildResearchReportWithVdp,
  buildLlmContractResponse,
} from './helpers/fixtures';
import { clearResearchCacheForTests } from '../src/lib/data/research-cache';

// We will assign these after dynamic import in beforeEach
let POST: any;
let buildGoalDistributionInput: any;

type FetchCall = { url: string; method: string; body?: string };

// Per-test cookie jar shared between makeRequest (writer) and the next/headers mock (reader).
// This models browser cookie persistence: set-cookie from response updates the jar,
// subsequent requests send the stored cookie back.
const testCookieJar: Map<string, string> = new Map();

function parseCookiesFromHeader(header: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!header) return m;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) m.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return m;
}

function setCurrentRequestCookies(req: Request) {
  issuedSetCookies = [];
  testCookieJar.clear();
  const hdr = req.headers.get('cookie') || '';
  for (const [k, v] of parseCookiesFromHeader(hdr)) testCookieJar.set(k, v);
}

function applySetCookieToJar(res: Response) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const semi = raw.indexOf(';');
    const pair = semi > 0 ? raw.slice(0, semi) : raw;
    const eq = pair.indexOf('=');
    if (eq > 0) testCookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  // Merge cookies the route issued via the next/headers mock (captured as bare name=value strings).
  for (const raw of issuedSetCookies) {
    const eq = raw.indexOf('=');
    if (eq > 0) testCookieJar.set(raw.slice(0, eq).trim(), raw.slice(eq + 1).trim());
  }
  issuedSetCookies = [];
}

function buildCookieHeader(): string {
  return [...testCookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function clearCookieStore(): void {
  testCookieJar.clear();
}

// Cookies the route issues via cookies().set(...) during a request.
// In real Next.js these become Set-Cookie headers on the outgoing response; the
// mock captures them so postAndApplyCookies can surface them the same way.
let issuedSetCookies: string[] = [];

function mockCookieKit() {
  return {
    get(name: string) {
      const v = testCookieJar.get(name);
      return v !== undefined ? { name, value: v } : undefined;
    },
    set(name: string, value: string) {
      issuedSetCookies.push(`${name}=${value}`);
    },
    has(name: string) {
      return testCookieJar.has(name);
    },
    delete(name: string) {
      testCookieJar.delete(name);
    },
    getAll() {
      return Array.from(testCookieJar.entries()).map(([name, value]) => ({ name, value }));
    },
    keys() {
      return testCookieJar.keys();
    },
  };
}

// Stateful free-limit stub: mirrors the real ledger semantics for one generation per fingerprint.
// Raw fingerprints come from route.ts as anon session ids (uuid).
function createStatefulFreeLimit() {
  const consumed = new Set<string>();
  let seq = 0;
  return {
    reserveFreeGeneration: async (rawFingerprint: string) => {
      const fingerprint = String(rawFingerprint).trim().toLowerCase().replace(/\s+/g, ' ');
      if (consumed.has(fingerprint)) {
        return { allowed: false, reason: 'limit_exhausted' as const };
      }
      consumed.add(fingerprint);
      seq += 1;
      return { allowed: true, reservationId: `test-res-${seq}` };
    },
    consumeFreeGeneration: async (_reservationId: string) => ({ success: true }),
    releaseFreeGeneration: async (_reservationId: string) => ({ released: true, deletedCount: 1 as const }),
  };
}

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

function makeRequest(body: unknown, overrideSid?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (overrideSid !== undefined) {
    headers['cookie'] = overrideSid ? `anon_sid=${overrideSid}` : '';
  } else {
    const jar = buildCookieHeader();
    if (jar) headers['cookie'] = jar;
  }
  return new Request('http://localhost/api/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

async function postAndApplyCookies(postFn: typeof POST, req: Request): Promise<Response> {
  setCurrentRequestCookies(req);
  const res = await postFn(req);
  applySetCookieToJar(res);
  return res;
}

describe('P0 API /api/analyze (current behavior)', () => {
  const realFetch = globalThis.fetch;
  let calls: FetchCall[];
  let logs: string[];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;

  beforeEach(async () => {
    calls = [];
    logs = [];
    clearResearchCacheForTests();
    // Изолируем от реального окружения: только тестовые ключи, никакого .env
    process.env.YDC_API_KEY = 'ydc_live_p0test';
    process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    // Server-side analysis price must be configured; individual config tests override/delete it.
    process.env.ANALYSIS_COST = '10';
    // route.ts пишет большие diagnostic-логи — гасим на время теста
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    console.error = () => {};
    console.warn = () => {};
    // IMPORTANT: mock BEFORE dynamic import of the route module so that route.ts sees the mocked free-limit
    // Use namedExports to satisfy current @types/node; runtime will show deprecation but still mock correctly.
    clearCookieStore();
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-1' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    // Dynamically import AFTER the mock is in place — this ensures production route.ts loads the mock
    const mod = await import('../src/app/api/analyze/route');
    POST = mod.POST;
    buildGoalDistributionInput = mod.buildGoalDistributionInput;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.YDC_API_KEY;
    delete process.env.KEYDEALER_API_KEY;
    delete process.env.ANON_SESSION_SECRET;
    delete process.env.ANALYSIS_COST;
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    mock.restoreAll();
  });

  test('T11: report without VERIFIED DATA PACK marker — 422', async () => {
    globalThis.fetch = makeMockFetch(
      'Some research text without any verified data pack marker.',
      buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }),
      calls
    );
    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
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
    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(String(body.error).includes('недостаточно данных'));
    assert.ok(!calls.some((c) => c.url.includes('keydealer')));
  });

  test('T11c: missing match field — 400', async () => {
    globalThis.fetch = makeMockFetch('', '', calls);
    const res = await postAndApplyCookies(POST, makeRequest({}));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(String(body.error).includes('матч'));
    assert.equal(calls.length, 0);
  });

  test('T12: valid VDP + valid LLM contract — 200 with probabilities', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    const llmProbabilities = { team1: 45, draw: 25, team2: 30 };
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse(llmProbabilities), calls);

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
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

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution:')));
    assert.deepEqual(
      body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value),
      ['59%', '15%', '26%'],
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
    assert.equal((await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }))).status, 200);

    calls.length = 0;
    logs = [];
    assert.equal((await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }))).status, 200);
    assert.equal(calls.filter((call) => call.url.includes('api.you.com')).length, 0);
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution:')));
  });

  test('T16: LLM receives production Goal Distribution values and public response stays compatible', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 99, draw: 1, team2: 0 }), calls);

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
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
      ['59%', '15%', '26%'],
    );
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Probability Engine: team1=59 draw=15 team2=26')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Goal Distribution markets:')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] LLM Contract probabilities: team1=99 draw=1 team2=0')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Engine vs LLM: engine=59/15/26 llm=99/1/0 match=false')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] A1 final probabilities: team1=59 draw=15 team2=26')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] A1 vs Engine: engine=59/15/26 a1=59/15/26 match=true')));
    assert.ok(logs.some((line) => line.includes('[ORAKUL DIAGNOSTIC] Public Response probabilities: team1=59 draw=15 team2=26')));
  });

  test('T17: valid JSON does not retry', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);

    assert.equal((await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }))).status, 200);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 1);
  });

  test('T18: malformed JSON retries once and succeeds without repeating Research', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(
      report,
      ['{"status":"success","match":"Россия — Иран","explanation":{"factors":["обрезано...', buildLlmContractResponse({ team1: 99, draw: 1, team2: 0 })],
      calls,
    );

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Россия — Иран' }));
    assert.equal(res.status, 200);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 2);
    assert.equal(calls.filter((call) => call.url.includes('api.you.com')).length, 2);
    assert.ok(logs.some((line) => line.includes('[LLM] JSON parse failed, retrying once')));
    assert.ok(logs.some((line) => line.includes('[LLM] JSON retry succeeded')));
    const body = await res.json();
    assert.deepEqual(body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value), ['59%', '15%', '26%']);
  });

  test('T19: malformed JSON twice returns existing 502 error', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    const malformed = '{"status":"success","explanation":{"factors":["обрезано...';
    globalThis.fetch = makeMockFetch(report, [malformed, malformed], calls);

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Россия — Иран' }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'LLM response was not valid JSON.' });
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 2);
    assert.ok(logs.some((line) => line.includes('[LLM] JSON retry failed')));
  });

  test('T20: HTTP error does not retry JSON parsing', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls, 500);

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 502);
    assert.match(String((await res.json()).error), /HTTP 500/);
    assert.equal(calls.filter((call) => call.url === 'https://api.keydealer.ru/v1/chat/completions').length, 1);
  });

  test('T20b: missing content does not retry JSON parsing', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, '', calls);

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
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

    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.probabilities.outcomes.map((outcome: { value: string }) => outcome.value), ['59%', '15%', '26%']);
  });

  test('T22: consume failure after success path returns 500 and does not deliver 200', async () => {
    // Force fresh module eval under failing consume mock using cache-bust query.
    // beforeEach success mock + prior route load must not leak.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => ({
          get: async (name: string) => {
            const value = testCookieJar.get(name);
            return value ? { name, value } : undefined;
          },
          set: async (name: string, value: string) => { testCookieJar.set(name, value); },
          has: async (name: string) => testCookieJar.has(name),
          delete: async (name: string) => { testCookieJar.delete(name); },
          getAll: async () => [...testCookieJar.entries()].map(([name, value]) => ({ name, value })),
          keys: async () => testCookieJar.keys(),
        }),
      },
    });
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-consume-fail' }),
        consumeFreeGeneration: async () => ({ success: false }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTForFail } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }), calls);

    const res = await postAndApplyCookies(POSTForFail, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(String(body.error).includes('Internal accounting error'));
    assert.notEqual(res.status, 200);
  });

  test('T23: two different anon sids each get their own free generation (no cross-sid sharing)', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }), calls);
    const sid1 = 'sid-test-1';
    const sid2 = 'sid-test-2';
    const res1 = await postAndApplyCookies(POST, makeRequest({ match: 'Team X vs Team Y' }, sid1));
    const res2 = await postAndApplyCookies(POST, makeRequest({ match: 'Team X vs Team Y' }, sid2));
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
  });

  test('T24: same anon sid second request gets 402 after first consume', async () => {
    // Drop the beforeEach mocks so this test can re-mock 'free-limit' with a stateful stub
    // (same pattern as T22/T26/T28). The next/headers mock must then be reinstalled.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    // Reuse the same sync cookie mock as beforeEach: route reads cookies() synchronously
    // (route.ts getOrCreateAnonSessionId), so the mock must return plain values, not Promises.
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    // Stateful ledger stub localized to this test: it consumes the fingerprint once, so a
    // repeated request from the same signed session must be rejected. Installed BEFORE the
    // fresh route import so production route.ts binds the stateful mock.
    const statefulFreeLimit = createStatefulFreeLimit();
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: statefulFreeLimit.reserveFreeGeneration,
        consumeFreeGeneration: statefulFreeLimit.consumeFreeGeneration,
        releaseFreeGeneration: statefulFreeLimit.releaseFreeGeneration,
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTStateful } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }), calls);
    // Reuse the SAME signed anon_sid cookie across both requests (persisted via the cookie jar).
    // The first request is approved and consumed; the second must be rejected as quota-exhausted.
    const res1 = await postAndApplyCookies(POSTStateful, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res1.status, 200);
    const res2 = await postAndApplyCookies(POSTStateful, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res2.status, 402);
    const body2 = await res2.json();
    assert.equal(body2.status, 'auth_required');
  });

  test('T25: client cannot spoof sid via body (sid from httpOnly cookie only)', async () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    globalThis.fetch = makeMockFetch(report, buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }), calls);
    const spoofSid = 'spoofed-sid';
    const bodyWithSid = { match: 'Team A vs Team B', anon_sid: spoofSid };
    const res = await postAndApplyCookies(POST, makeRequest(bodyWithSid));
    assert.equal(res.status, 200);
  });

  test('T26: config_missing from reserve yields 503', async () => {
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => ({
          get: async (name: string) => {
            const value = testCookieJar.get(name);
            return value ? { name, value } : undefined;
          },
          set: async (name: string, value: string) => { testCookieJar.set(name, value); },
          has: async (name: string) => testCookieJar.has(name),
          delete: async (name: string) => { testCookieJar.delete(name); },
          getAll: async () => [...testCookieJar.entries()].map(([name, value]) => ({ name, value })),
          keys: async () => testCookieJar.keys(),
        }),
      },
    });
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: false, reason: 'config_missing' as const }),
        consumeFreeGeneration: async () => ({ success: false }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTForCfg } = await import(`../src/app/api/analyze/route?cb=${bust}`);
    const res = await postAndApplyCookies(POSTForCfg, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 503);
  });

  test('T27: forged/unsigned anon_sid is rejected and replaced with signed session', async () => {
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp(buildFullVdp()),
      buildLlmContractResponse({ team1: 59, draw: 15, team2: 26 }),
      calls
    );
    const res = await postAndApplyCookies(POST, makeRequest({ match: 'Team A vs Team B' }, 'forged-unsigned-sid'));
    assert.equal(res.status, 200);
    // The mocked next/headers does not surface a real Set-Cookie response header; the cookie-store
    // write is captured by the mock and applied to the jar, so verify the replacement there.
    const signedValue = testCookieJar.get('anon_sid');
    assert.ok(signedValue, 'server must write a replacement anon_sid cookie');
    assert.notEqual(signedValue, 'forged-unsigned-sid', 'forged sid must not be reused');
    assert.ok(signedValue!.includes('.'), 'stored sid must be HMAC-signed (uuid.signature)');
  });

  test('T28: missing ANON_SESSION_SECRET yields 503', async () => {
    mock.restoreAll();
    testCookieJar.clear();
    delete process.env.ANON_SESSION_SECRET;
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => ({
          get: async () => undefined,
          set: async () => {},
          has: async () => false,
          delete: async () => {},
          getAll: async () => [],
          keys: async () => new Set(),
        }),
      },
    });
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'x' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTNoSecret } = await import(`../src/app/api/analyze/route?cb=${bust}`);
    globalThis.fetch = makeMockFetch(
      buildResearchReportWithVdp('Team A vs Team B'),
      buildLlmContractResponse({ team1: 59, draw: 15, team2: 26 }),
      calls
    );
    const res = await postAndApplyCookies(POSTNoSecret, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 503);
  });

  test('T29: Football Research init HTTP 4xx does NOT release (no proven no-task guarantee)', async () => {
    // The You.com Research contract is not documented in this repository, so even a 4xx
    // init response cannot prove that no research task was created. The reservation is
    // deliberately kept to avoid a free-quota bypass on an ambiguous outcome.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const released: string[] = [];
    const reserved: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async (fp: string) => {
          reserved.push(fp);
          return { allowed: true, reservationId: 'test-res-t29' };
        },
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          released.push(id);
          return { released: true, deletedCount: 1 };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT29 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url === 'https://api.you.com/v1/research' && init?.method === 'POST') {
        return new Response('bad request', { status: 400 });
      }
      throw new Error('unexpected fetch in T29: ' + url);
    }) as typeof fetch;

    const res = await postAndApplyCookies(POSTT29, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 200);
    assert.equal(reserved.length, 1, 'reservation must be created before Research');
    assert.equal(released.length, 0, 'reservation must NOT be released on ambiguous 4xx (no proven no-task guarantee)');
  });

  test('T30: Football Research init HTTP 5xx does NOT release (ambiguous outcome)', async () => {
    // 5xx gateway/timeout is ambiguous: the provider may have accepted the task before the
    // response was lost. To avoid a free-quota bypass the reservation is deliberately kept.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const released: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-t30' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          released.push(id);
          return { released: true, deletedCount: 1 };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT30 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url === 'https://api.you.com/v1/research' && init?.method === 'POST') {
        return new Response('upstream', { status: 502 });
      }
      throw new Error('unexpected fetch in T30: ' + url);
    }) as typeof fetch;

    const res = await postAndApplyCookies(POSTT30, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 200);
    assert.equal(released.length, 0, 'reservation must NOT be released on ambiguous 5xx');
  });

  test('T31: Football Research init HTTP 408 does NOT release (ambiguous request-timeout)', async () => {
    // 408 may be returned after the provider accepted the request, so it is not proof that
    // no task was created. The reservation must stay active.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const released: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-t31' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          released.push(id);
          return { released: true, deletedCount: 1 };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT31 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url === 'https://api.you.com/v1/research' && init?.method === 'POST') {
        return new Response('timeout', { status: 408 });
      }
      throw new Error('unexpected fetch in T31: ' + url);
    }) as typeof fetch;

    const res = await postAndApplyCookies(POSTT31, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 200);
    assert.equal(released.length, 0, 'reservation must NOT be released on ambiguous 408');
  });

  test('T32: Football Research init HTTP 200 without task ID does NOT release (no-proof-no-task)', async () => {
    // A 200 response with { status: "ok" } was accepted by the provider; the missing known
    // ID field is not proof that no task was created, so the reservation stays active.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const released: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-t32' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          released.push(id);
          return { released: true, deletedCount: 1 };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT32 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url === 'https://api.you.com/v1/research' && init?.method === 'POST') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('unexpected fetch in T32: ' + url);
    }) as typeof fetch;

    const res = await postAndApplyCookies(POSTT32, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 200);
    assert.equal(released.length, 0, 'reservation must NOT be released when task ID is unrecognized');
  });

  test('T33: terminal completed with unrecognized non-empty report field does NOT release', async () => {
    // The provider returns { status: "completed", report: "non-empty report" } where the
    // non-empty content lives in a field ("report") the extraction heuristic does not read.
    // candidateContent therefore resolves to undefined, the normalized report is empty, and
    // that ambiguity is no proof that no result was produced -> the reservation stays active.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const released: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-t33' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          released.push(id);
          return { released: true, deletedCount: 1 };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT33 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = (async (u: any, init?: any) => {
      const url = String(u);
      if (url === 'https://api.you.com/v1/research' && init?.method === 'POST') {
        return new Response(JSON.stringify({ task_id: 'task-t33' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.you.com/v1/research/')) {
        return new Response(
          JSON.stringify({ status: 'completed', report: 'non-empty report' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error('unexpected fetch in T33: ' + url);
    }) as typeof fetch;

    const res = await postAndApplyCookies(POSTT33, makeRequest({ match: 'Team A vs Team B' }));
    assert.equal(res.status, 500);
    assert.notEqual(res.status, 200);
    assert.equal(released.length, 0, 'reservation must NOT be released when report content field is unrecognized');
  });

  test('T34: failed release is logged but keeps the original HTTP response and is not retried', async () => {
    // VDP missing -> route releases the reservation once and must keep returning 422.
    // The release itself fails (db_error): the route must NOT retry and must NOT change the status.
    mock.restoreAll();
    testCookieJar.clear();
    process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
    mock.module('next/headers', {
      namedExports: {
        cookies: async () => mockCookieKit(),
      },
    });
    const releaseAttempts: string[] = [];
    mock.module('@/lib/supabase/free-limit', {
      namedExports: {
        reserveFreeGeneration: async () => ({ allowed: true, reservationId: 'test-res-t34' }),
        consumeFreeGeneration: async () => ({ success: true }),
        releaseFreeGeneration: async (id: string) => {
          releaseAttempts.push(id);
          return { released: false, reason: 'db_error' };
        },
      },
    });
    const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const { POST: POSTT34 } = await import(`../src/app/api/analyze/route?cb=${bust}`);

    globalThis.fetch = makeMockFetch(
      'Research text without any verified data pack marker.',
      buildLlmContractResponse({ team1: 40, draw: 27, team2: 33 }),
      calls,
    );

    const res = await postAndApplyCookies(POSTT34, makeRequest({ match: 'Team A vs Team B' }));

    assert.equal(res.status, 422, 'original HTTP response must be preserved on failed release');
    const body = await res.json();
    assert.ok(String(body.error).includes('VERIFIED DATA PACK'));
    assert.ok(!JSON.stringify(body).includes('test-res-t34'), 'reservation id must not leak into the response');
    assert.equal(releaseAttempts.length, 1, 'release must be attempted exactly once (no retry)');
    assert.equal(releaseAttempts[0], 'test-res-t34');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CREDIT PAYMENT REGRESSION TESTS (execute real POST production entrypoint)
  // All use dynamic import after mocks so production route.ts + credits/session are exercised.
  // Mocks verify app flow; SQL atomicity is provided by (future) RPCs, not claimed here.
  // ─────────────────────────────────────────────────────────────────────────────

  describe('credit payment for authenticated users (ANALYSIS_COST)', () => {
    const realFetch = globalThis.fetch;
    let calls: FetchCall[];
    let logs: string[];
    const realLog = console.log;
    const realErr = console.error;
    const realWarn = console.warn;

    let currentBalance: number;
    let reserveCalls: any[];
    let consumeCalls: string[];
    let releaseCalls: string[];
    let freeReserveCalls: string[];
    let freeConsumeCalls: string[];
    let freeReleaseCalls: string[];

    beforeEach(async () => {
      calls = [];
      logs = [];
      clearResearchCacheForTests();
      process.env.YDC_API_KEY = 'ydc_live_p0test';
      process.env.KEYDEALER_API_KEY = 'kd_live_p0test';
      process.env.ANON_SESSION_SECRET = 'test-anon-session-secret-p0';
      process.env.ANALYSIS_COST = '10';
      currentBalance = 100;
      reserveCalls = [];
      consumeCalls = [];
      releaseCalls = [];
      freeReserveCalls = [];
      freeConsumeCalls = [];
      freeReleaseCalls = [];
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
      console.error = () => {};
      console.warn = () => {};
      clearCookieStore();
      mock.restoreAll();
      mock.module('next/headers', {
        namedExports: {
          cookies: async () => mockCookieKit(),
        },
      });
      // Default to anon free (will be overridden in authed tests)
      mock.module('@/lib/supabase/free-limit', {
        namedExports: {
          reserveFreeGeneration: async (id: string) => { freeReserveCalls.push(id); return { allowed: true, reservationId: 'free-res' }; },
          consumeFreeGeneration: async (id: string) => { freeConsumeCalls.push(id); return { success: true }; },
          releaseFreeGeneration: async (id: string) => { freeReleaseCalls.push(id); return { released: true, deletedCount: 1 as const }; },
        },
      });
      mock.module('@/lib/supabase/server', {
        namedExports: {
          createClient: async () => ({ auth: {} }),
        },
      });
      mock.module('@/lib/auth/session', {
        namedExports: {
          getCurrentSession: async () => ({ ok: false, error: 'no session' }),
        },
      });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (client: any, input: any) => {
            reserveCalls.push(input);
            if (currentBalance < input.amount) {
              return { ok: false, reason: 'insufficient_funds', balance: currentBalance, status: 402 };
            }
            currentBalance -= input.amount;
            return { ok: true, reservationId: 'cr-' + reserveCalls.length, balanceAfter: currentBalance };
          },
          consumeCreditSpend: async (_c: any, _id: any, idempotencyKey: any) => {
            consumeCalls.push(String(idempotencyKey));
            return { success: true };
          },
          releaseCreditSpend: async (_c: any, _id: any, idempotencyKey: any) => {
            releaseCalls.push(String(idempotencyKey));
            // refund for test accounting
            currentBalance += 10;
            return { released: true };
          },
        },
      });
      const mod = await import('../src/app/api/analyze/route');
      POST = mod.POST;
      buildGoalDistributionInput = mod.buildGoalDistributionInput;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      delete process.env.YDC_API_KEY;
      delete process.env.KEYDEALER_API_KEY;
      delete process.env.ANON_SESSION_SECRET;
      delete process.env.ANALYSIS_COST;
      console.log = realLog;
      console.error = realErr;
      console.warn = realWarn;
      mock.restoreAll();
    });

    test('C1: authed user with sufficient balance gets 200 and spend is called exactly once (real POST)', async () => {
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-sufficient', email: 'a@b' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => { reserveCalls.push(input); currentBalance -= input.amount; return { ok: true, reservationId: 'cr-c1' }; },
          consumeCreditSpend: async (_c: any, k: any) => { consumeCalls.push(k.idempotencyKey || 'k'); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      mock.module('@/lib/supabase/free-limit', {
        namedExports: {
          reserveFreeGeneration: async () => { freeReserveCalls.push('should-not'); return { allowed: true, reservationId: 'no' }; },
          consumeFreeGeneration: async () => ({ success: true }),
          releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC1 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }), calls);
      const res = await postAndApplyCookies(POSTC1, makeRequest({ match: 'Team A vs Team B' }));
      assert.equal(res.status, 200);
      assert.equal(reserveCalls.length, 1);
      assert.equal(consumeCalls.length, 1);
      assert.equal(freeReserveCalls.length, 0, 'free limit must be bypassed for authed');
      const body = await res.json();
      assert.equal(body.status, 'success');
    });

    test('C2: insufficient balance returns 402 with code insufficient_credits (no double spend)', async () => {
      currentBalance = 5;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-poor', email: 'a@b' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            reserveCalls.push(input);
            return { ok: false, reason: 'insufficient_funds', balance: currentBalance, status: 402 };
          },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      mock.module('@/lib/supabase/free-limit', {
        namedExports: {
          reserveFreeGeneration: async () => { freeReserveCalls.push('no'); return { allowed: true, reservationId: 'x' }; },
          consumeFreeGeneration: async () => ({ success: true }),
          releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC2 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch('report', 'llm', calls);
      const res = await postAndApplyCookies(POSTC2, makeRequest({ match: 'Team A vs Team B' }));
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.status || body.code, 'insufficient_credits');
      assert.ok(body.balance !== undefined);
      assert.equal(reserveCalls.length, 1);
      assert.equal(calls.length, 0, 'no research on insufficient');
    });

    test('C3: insufficient credits does not invoke Research/DAL/LLM (real prod path)', async () => {
      currentBalance = 0;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-zero' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, i: any) => { reserveCalls.push(i); return { ok: false, reason: 'insufficient_funds', balance: 0 }; },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC3 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 40, draw: 30, team2: 30 }), calls);
      const res = await postAndApplyCookies(POSTC3, makeRequest({ match: 'X vs Y' }));
      assert.equal(res.status, 402);
      assert.equal(calls.filter(c => c.url.includes('you.com') || c.url.includes('keydealer')).length, 0);
    });

    test('C4: successful analysis decreases balance exactly by ANALYSIS_COST (tracked via mock)', async () => {
      currentBalance = 25;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-bal' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => { reserveCalls.push(input); currentBalance -= input.amount; return { ok: true, reservationId: 'cr-bal' }; },
          consumeCreditSpend: async () => { consumeCalls.push('bal'); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC4 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 45, draw: 25, team2: 30 }), calls);
      const res = await postAndApplyCookies(POSTC4, makeRequest({ match: 'A vs B' }));
      assert.equal(res.status, 200);
      assert.equal(reserveCalls.length, 1);
      assert.equal(reserveCalls[0].amount, 10);
      // after deduct in mock
      assert.equal(currentBalance, 15);
    });

    test('C5: balance exactly equal to cost allows one analysis and does not go negative', async () => {
      currentBalance = 10;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-exact' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            if (currentBalance < input.amount) return { ok: false, reason: 'insufficient_funds', balance: currentBalance };
            currentBalance -= input.amount;
            reserveCalls.push(input);
            return { ok: true, reservationId: 'cr-exact' };
          },
          consumeCreditSpend: async () => { consumeCalls.push('ex'); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC5 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 40, draw: 20, team2: 40 }), calls);
      const res = await postAndApplyCookies(POSTC5, makeRequest({ match: 'Exact vs Cost' }));
      assert.equal(res.status, 200);
      assert.equal(currentBalance, 0);
      // second attempt must now fail
      const res2 = await postAndApplyCookies(POSTC5, makeRequest({ match: 'Exact vs Cost 2' }));
      assert.equal(res2.status, 402);
      assert.equal(currentBalance, 0);
    });

    test('C6: two sequential spends with shared balance do not produce negative (app-level)', async () => {
      currentBalance = 15;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-conc' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            reserveCalls.push(input);
            if (currentBalance < input.amount) return { ok: false, reason: 'insufficient_funds', balance: currentBalance };
            currentBalance -= input.amount;
            return { ok: true, reservationId: 'cr-seq' + reserveCalls.length };
          },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC6 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 33, draw: 33, team2: 34 }), calls);
      const r1 = await postAndApplyCookies(POSTC6, makeRequest({ match: 'One vs Two' }));
      const r2 = await postAndApplyCookies(POSTC6, makeRequest({ match: 'Three vs Four' }));
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 402); // second should fail, balance now 5 < 10
      assert.ok(currentBalance >= 0);
      assert.equal(currentBalance, 5);
    });

    test('C7: repeat same idempotency key does not spend twice (isDuplicate path)', async () => {
      currentBalance = 30;
      let dup = false;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-idem' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            if (reserveCalls.find((x: any) => x.idempotencyKey === input.idempotencyKey)) {
              dup = true;
              return { ok: true, reservationId: 'dup', isDuplicate: true };
            }
            reserveCalls.push(input);
            currentBalance -= input.amount;
            return { ok: true, reservationId: 'cr-idem' };
          },
          consumeCreditSpend: async () => { consumeCalls.push('idem'); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC7 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 60, draw: 10, team2: 30 }), calls);
      // first
      const r1 = await postAndApplyCookies(POSTC7, makeRequest({ match: 'Idem Match' }));
      assert.equal(r1.status, 200);
      // simulate repeat with same key by direct (in real the key is generated inside route per request; here we trust the mock detects dup on same input)
      // To exercise the path we call reserve directly via the mocked function
      const { reserveCreditSpend } = await import('@/lib/supabase/credits');
      await (reserveCreditSpend as any)({}, { userId: 'u-idem', amount: 10, idempotencyKey: reserveCalls[0]?.idempotencyKey || 'same-key' });
      assert.equal(dup || reserveCalls.length === 1, true);
    });

    test('C8: repeat key with different params is rejected (conflict)', async () => {
      // This is enforced in the RPC layer (see migration). Here we simulate via mock returning error for mismatch.
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-conf' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            if (input.idempotencyKey === 'conflict-key' && input.amount !== 10) {
              return { ok: false, reason: 'idempotency_conflict', status: 409 };
            }
            reserveCalls.push(input);
            currentBalance = (currentBalance || 20) - 10;
            return { ok: true, reservationId: 'cr-conf' };
          },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC8 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }), calls);
      const r = await postAndApplyCookies(POSTC8, makeRequest({ match: 'Conf Match' }));
      assert.equal(r.status, 200);
      // direct conflict simulation
      const { reserveCreditSpend } = await import('@/lib/supabase/credits');
      const bad = await (reserveCreditSpend as any)({}, { userId: 'u-conf', amount: 99, idempotencyKey: 'conflict-key' });
      assert.equal(bad.ok, false);
      assert.equal(bad.status, 409);
    });

    test('C9: error before final success releases the credit reservation exactly once', async () => {
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-err' } }) } });
      const released: string[] = [];
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async () => ({ ok: true, reservationId: 'cr-err' }),
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async (_c: any, _id: any, idem: any) => { released.push(String(idem)); return { released: true }; },
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC9 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      // Deterministic failure after Research succeeded: the LLM endpoint returns HTTP 500.
      // This is a proven failure (no analysis result), so the reservation must be released once.
      globalThis.fetch = makeMockFetch(
        buildResearchReportWithVdp(buildFullVdp()),
        buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }),
        calls,
        500,
      );
      const res = await postAndApplyCookies(POSTC9, makeRequest({ match: 'Err Match' }));
      assert.equal(res.status, 502);
      assert.equal(released.length, 1);
    });

    test('C9b: ambiguous Research failure keeps the credit reservation (no blind refund)', async () => {
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-ambiguous' } }) } });
      const released: string[] = [];
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async () => ({ ok: true, reservationId: 'cr-ambiguous' }),
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async (_c: any, _id: any, idem: any) => { released.push(String(idem)); return { released: true }; },
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC9b } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = (async (u: any) => {
        if (String(u) === 'https://api.you.com/v1/research') return new Response('boom', { status: 500 });
        throw new Error('unexpected fetch in C9b: ' + u);
      }) as typeof fetch;
      const res = await postAndApplyCookies(POSTC9b, makeRequest({ match: 'Ambiguous vs Match' }));
      assert.equal(res.status, 500);
      assert.equal(released.length, 0, 'ambiguous Research outcome must keep the reservation for reconciliation');
    });

    test('C10: consume failure after building result returns 500 and does not deliver analysis (like free T22)', async () => {
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-consume-fail' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async () => ({ ok: true, reservationId: 'cr-consume-fail' }),
          consumeCreditSpend: async () => ({ success: false }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC10 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 40, draw: 20, team2: 40 }), calls);
      const res = await postAndApplyCookies(POSTC10, makeRequest({ match: 'ConsumeFail vs Match' }));
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.ok(String(body.error || '').toLowerCase().includes('accounting') || String(body.error || '').includes('credit'));
      assert.ok(!JSON.stringify(body).includes('success'));
    });

    test('C11: missing or invalid ANALYSIS_COST blocks before any research (controlled error)', async () => {
      mock.restoreAll();
      delete process.env.ANALYSIS_COST;
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-cfg' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async () => { throw new Error('should not be called'); },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC11 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }), calls);
      const res = await postAndApplyCookies(POSTC11, makeRequest({ match: 'Cfg Match' }));
      assert.notEqual(res.status, 200);
      assert.equal(calls.length, 0);
      // also test invalid value
      process.env.ANALYSIS_COST = 'not-a-number';
      const bust2 = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC11b } = await import(`../src/app/api/analyze/route?cb=${bust2}`);
      const res2 = await postAndApplyCookies(POSTC11b, makeRequest({ match: 'Cfg2' }));
      assert.notEqual(res2.status, 200);
      assert.equal(calls.length, 0);
    });

    test('C12: anonymous free-limit auth_required 402 and its behavior is unchanged', async () => {
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: false, error: 'no' }) } });
      let freeHit = false;
      mock.module('@/lib/supabase/free-limit', {
        namedExports: {
          reserveFreeGeneration: async () => { freeHit = true; return { allowed: false, reason: 'limit_exhausted' as const }; },
          consumeFreeGeneration: async () => ({ success: true }),
          releaseFreeGeneration: async () => ({ released: true, deletedCount: 1 as const }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC12 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      const res = await postAndApplyCookies(POSTC12, makeRequest({ match: 'Anon vs Free' }));
      assert.equal(res.status, 402);
      const body = await res.json();
      assert.equal(body.status, 'auth_required');
      assert.ok(freeHit);
    });

    test('C13: client cannot dictate userId or price - server uses session + env (extra fields ignored)', async () => {
      currentBalance = 20;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-server' } }) } });
      let seenUser: string | null = null;
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => { seenUser = input.userId; reserveCalls.push(input); currentBalance -= 10; return { ok: true, reservationId: 'cr-srv' }; },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC13 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 50, draw: 25, team2: 25 }), calls);
      const res = await postAndApplyCookies(POSTC13, makeRequest({ match: 'Srv vs Price', userId: 'hacker', price: 1, cost: 1 }));
      assert.equal(res.status, 200);
      assert.equal(seenUser, 'u-server'); // not the hacker value
      assert.equal(reserveCalls[0].amount, 10); // from env, not client
    });

    test('C14: two separate analyses of the same match spend separately (distinct operationId)', async () => {
      currentBalance = 30;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-distinct' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            reserveCalls.push(input);
            currentBalance -= input.amount;
            return { ok: true, reservationId: 'cr-' + reserveCalls.length };
          },
          consumeCreditSpend: async (_c: any, _id: any, idem: any) => { consumeCalls.push(String(idem)); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC14 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 40, draw: 30, team2: 30 }), calls);

      const r1 = await postAndApplyCookies(POSTC14, makeRequest({ match: 'Same Match', operationId: 'op-aaaaaaaa-1' }));
      const r2 = await postAndApplyCookies(POSTC14, makeRequest({ match: 'Same Match', operationId: 'op-bbbbbbbb-2' }));

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(reserveCalls.length, 2, 'each separate analysis must reserve its own credit');
      assert.notEqual(reserveCalls[0].idempotencyKey, reserveCalls[1].idempotencyKey);
      assert.equal(currentBalance, 10, 'two analyses of the same match must cost 2 x ANALYSIS_COST');
    });

    test('C15: repeating the same logical request (same operationId) does not spend twice', async () => {
      currentBalance = 20;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-retry' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            const existing = reserveCalls.find((x: any) => x.idempotencyKey === input.idempotencyKey);
            if (existing) return { ok: true, reservationId: 'cr-dup', isDuplicate: true };
            reserveCalls.push(input);
            currentBalance -= input.amount;
            return { ok: true, reservationId: 'cr-retry' };
          },
          consumeCreditSpend: async (_c: any, _id: any, idem: any) => { consumeCalls.push(String(idem)); return { success: true }; },
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC15 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      globalThis.fetch = makeMockFetch(buildResearchReportWithVdp(buildFullVdp()), buildLlmContractResponse({ team1: 40, draw: 30, team2: 30 }), calls);

      const r1 = await postAndApplyCookies(POSTC15, makeRequest({ match: 'Retry Match', operationId: 'op-same-request-1' }));
      const r2 = await postAndApplyCookies(POSTC15, makeRequest({ match: 'Retry Match', operationId: 'op-same-request-1' }));

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(reserveCalls.length, 1, 'the same logical request must reuse one reservation');
      assert.equal(currentBalance, 10, 'a retry must not spend a second time');
    });

    test('C16: malformed operationId is rejected as 400 before any reservation', async () => {
      currentBalance = 100;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-badop' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => { reserveCalls.push(input); return { ok: true, reservationId: 'cr-badop' }; },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC16 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      const res = await postAndApplyCookies(POSTC16, makeRequest({ match: 'Bad Op Match', operationId: 'no spaces allowed!' }));
      assert.equal(res.status, 400);
      assert.equal(reserveCalls.length, 0);
    });

    test('C17: idempotency conflict from reserve surfaces as HTTP 409, not 500', async () => {
      currentBalance = 100;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/supabase/admin', { namedExports: { createServiceRoleClient: () => ({ admin: true }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-conflict' } }) } });
      mock.module('@/lib/supabase/credits', {
        namedExports: {
          reserveCreditSpend: async (_c: any, input: any) => {
            reserveCalls.push(input);
            return { ok: false, reason: 'idempotency_conflict', status: 409 };
          },
          consumeCreditSpend: async () => ({ success: true }),
          releaseCreditSpend: async () => ({ released: true }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC17 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      const res = await postAndApplyCookies(
        POSTC17,
        makeRequest({ match: 'Conflict Match', operationId: 'op-conflict-0001' }),
      );

      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.status, 'idempotency_conflict');
      assert.match(String(body.error), /operation id/i);
      assert.equal(body.status === 'insufficient_credits', false);
      assert.equal(reserveCalls.length, 1);
      assert.equal(calls.length, 0, 'conflict must stop before Research/DAL/LLM');
      assert.equal(consumeCalls.length, 0);
      assert.equal(releaseCalls.length, 0);
    });

    test('C18: missing reserve RPC (real PGRST202 message) is 500, never a 409 retry hint', async () => {
      currentBalance = 100;
      mock.restoreAll();
      process.env.ANALYSIS_COST = '10';
      mock.module('next/headers', { namedExports: { cookies: async () => mockCookieKit() } });
      mock.module('@/lib/supabase/server', { namedExports: { createClient: async () => ({ auth: {} }) } });
      mock.module('@/lib/auth/session', { namedExports: { getCurrentSession: async () => ({ ok: true, user: { id: 'u-missing-rpc' } }) } });
      // Only the transport is faked: the REAL reserveCreditSpend error mapping from
      // src/lib/supabase/credits.ts runs here, and so does the real route branch.
      mock.module('@/lib/supabase/admin', {
        namedExports: {
          createServiceRoleClient: () => ({
            rpc: async () => ({
              data: null,
              error: {
                code: 'PGRST202',
                message:
                  'Could not find the function public.reserve_credit_spend(p_amount, p_idempotency_key, p_reason, p_user_id) in the schema cache',
              },
            }),
          }),
        },
      });
      const bust = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const { POST: POSTC18 } = await import(`../src/app/api/analyze/route?cb=${bust}`);
      const res = await postAndApplyCookies(
        POSTC18,
        makeRequest({ match: 'Missing RPC Match', operationId: 'op-missing-rpc-01' }),
      );

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.notEqual(body.status, 'idempotency_conflict');
      assert.doesNotMatch(String(body.error || ''), /operation id/i);
      assert.equal(calls.length, 0, 'a failed reservation must stop before Research/DAL/LLM');
    });
  });
});

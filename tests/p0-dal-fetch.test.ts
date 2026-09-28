// STEP 10: offline-тесты KeyDealer Web Fetch adapter + fixture extraction + resolver.
// Никаких реальных API: globalThis.fetch замокан в каждом тесте.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYDEALER_WEB_FETCH_ENDPOINT,
  KEYDEALER_WEB_FETCH_SOURCE,
  createKeyDealerWebFetcher,
} from '../src/lib/data/fetchers';
import { extractFixtureFromText } from '../src/lib/data/fixture-extractor';
import {
  buildMatchCacheKey,
  getSharedDataPackCache,
  matchQueryFromFreeForm,
  resolveDataPack,
} from '../src/lib/data/resolver';
import { MemoryCache } from '../src/lib/data/cache';
import type { DataPack, Fixture } from '../src/lib/data/types';

// ─────────────────────────────── helpers ───────────────────────────────

function kdPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: 'https://www.uefa.com/match-example',
    status: 200,
    content_type: 'text/html',
    title: 'Belgium v France',
    content: 'Belgium\nFrance\nUEFA Nations League\nKing Baudouin Stadium\nBrussels',
    truncated: false,
    keydealer_billing: { charged_rub: 0, charge_source: 'included' },
    ...overrides,
  });
}

// Конфиг-ключ строится той же production-функцией, что и ключ кэша resolver-а.
function cfgKey(freeFormMatch: string): string {
  return buildMatchCacheKey(matchQueryFromFreeForm(freeFormMatch));
}

function okBody(text: string): Response {
  return new Response(text, { status: 200 });
}

// ───────────────────── T1 — успешный KeyDealer Fetch ───────────────────

describe('STEP 10 T1: успешный KeyDealer Fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('content извлечён, provenance сохранён', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, init?: unknown) => {
      seenInit = init as RequestInit;
      return okBody(kdPayload());
    }) as typeof fetch;

    const fetcher = createKeyDealerWebFetcher();
    const result = await fetcher.fetch({ kind: 'fixture', url: 'https://www.uefa.com/match-example' });

    assert.equal(result.error, null);
    assert.ok(result.data?.includes('King Baudouin Stadium'));
    assert.equal(result.source.id, 'keydealer-web-fetch');
    assert.ok(result.fetchedAt);
    // Authorization header присутствует (нужен для API), но секрет в результат не попадает.
    const headers = (seenInit?.headers ?? {}) as Record<string, string>;
    assert.match(headers.Authorization ?? '', /^Bearer .+/);
    assert.equal(JSON.stringify(result).includes('kd_live_test'), false);
    delete process.env.KEYDEALER_API_KEY;
  });
});

// ─────────────── T2 — HTTP error / T3 — timeout / T4 — JSON ────────────

describe('STEP 10 T2–T4: ошибки fetcher-а', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.KEYDEALER_API_KEY;
  });

  test('T2: HTTP 403/429/500 → структурированная ошибка, без секрета, DataPack null-safe', async () => {
    for (const status of [403, 429, 500]) {
      process.env.KEYDEALER_API_KEY = 'kd_live_test';
      globalThis.fetch = (async () => new Response('denied', { status })) as typeof fetch;
      const fetcher = createKeyDealerWebFetcher();
      const result = await fetcher.fetch({ kind: 'fixture', url: 'https://example.com/x' });
      assert.equal(result.error?.kind, 'http');
      assert.equal(result.error?.status, status);
      assert.equal(result.data, null);
      assert.equal(JSON.stringify(result).includes('kd_live_test'), false);
      // null-safe: пустой DataPack из resolver не содержит fixture.
      const outcome = await resolveDataPack(
        matchQueryFromFreeForm('Belgium vs France'),
        {
          cache: new MemoryCache<DataPack>(),
          keyDealerWebFetcher: fetcher,
          sourceUrls: [{ matchKey: cfgKey('Belgium vs France'), url: 'https://example.com/x' }],
        }
      );
      assert.equal(outcome.dataPack.fixture, null);
      assert.equal(outcome.dataPack.status, 'empty');
    }
  });

  test('T3: AbortError → kind=timeout', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    globalThis.fetch = ((_url: unknown, init?: unknown) =>
      new Promise<Response>((_resolve, reject) => {
        (init as RequestInit | undefined)?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;
    const fetcher = createKeyDealerWebFetcher({ timeoutMs: 5_000 });
    const result = await fetcher.fetch({ kind: 'fixture', url: 'https://example.com/slow', timeoutMs: 20 });
    assert.equal(result.error?.kind, 'timeout');
  });

  test('T4: malformed JSON → kind=parse, без crash и fake data', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    globalThis.fetch = (async () => okBody('{"url": "x", broken')) as typeof fetch;
    const fetcher = createKeyDealerWebFetcher();
    const result = await fetcher.fetch({ kind: 'fixture', url: 'https://example.com/x' });
    assert.equal(result.error?.kind, 'parse');
    assert.equal(result.data, null);
  });
});

// ─────────────── T5 — cache hit / T6 — missing URL / T8 ────────────────

describe('STEP 10 T5/T6/T8: resolver + cache + flag', () => {
  const realFetch = globalThis.fetch;
  let fetchCalls: number;

  beforeEach(() => {
    fetchCalls = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.KEYDEALER_API_KEY;
    getSharedDataPackCache().clear();
  });

  test('T5: первый запрос → fetch, второй по тому же ключу → cache hit, fetch НЕ вызывается', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return okBody(kdPayload());
    }) as typeof fetch;

    const cache = new MemoryCache<DataPack>(24 * 60 * 60_000);
    const opts = {
      cache,
      keyDealerWebFetcher: createKeyDealerWebFetcher(),
      sourceUrls: [{ matchKey: cfgKey('Belgium vs France'), url: 'https://www.uefa.com/match-example' }],
    };
    const first = await resolveDataPack(matchQueryFromFreeForm('Belgium vs France'), opts);
    assert.equal(first.cacheHit, false);
    assert.equal(fetchCalls, 1);
    const second = await resolveDataPack(matchQueryFromFreeForm('BELGIUM vs france'), opts);
    assert.equal(second.cacheHit, true);
    assert.equal(fetchCalls, 1, 'при cache hit KeyDealer Fetch не вызывается');  });

  test('T6: URL отсутствует → нет fetch, нет search, честный empty DataPack', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return okBody(kdPayload());
    }) as typeof fetch;

    const outcome = await resolveDataPack(matchQueryFromFreeForm('Spain vs Italy'), {
      cache: new MemoryCache<DataPack>(),
      keyDealerWebFetcher: createKeyDealerWebFetcher(),
      sourceUrls: [{ matchKey: cfgKey('Belgium vs France'), url: 'https://www.uefa.com/match-example' }],
    });
    assert.equal(fetchCalls, 0, 'без явного URL fetch не вызывается');
    assert.equal(outcome.dataPack.fixture, null);
    assert.equal(outcome.dataPack.status, 'empty');
  });

  test('T8: KD endpoint единственный — /v1/search нигде не вызывается', async () => {
    process.env.KEYDEALER_API_KEY = 'kd_live_test';
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return okBody(kdPayload());
    }) as typeof fetch;

    await resolveDataPack(matchQueryFromFreeForm('Belgium vs France'), {
      cache: new MemoryCache<DataPack>(),
      keyDealerWebFetcher: createKeyDealerWebFetcher(),
      sourceUrls: [{ matchKey: cfgKey('Belgium vs France'), url: 'https://www.uefa.com/match-example' }],
    });
    assert.equal(urls.length, 1);
    assert.equal(urls[0], KEYDEALER_WEB_FETCH_ENDPOINT);
    assert.equal(urls.some((u) => u.includes('/v1/search')), false);
  });
});

// ─────────────── T7 — fixture extraction (null-safe) ───────────────

describe('STEP 10 T7: fixture extraction', () => {
  test('teams/competition/venue/city найдены, date отсутствует → null', () => {
    const content = 'Belgium\nFrance\nUEFA Nations League\nKing Baudouin Stadium\nBrussels';
    const fixture: Fixture = extractFixtureFromText(content, {
      team1: 'Belgium',
      team2: 'France',
      sourceUrl: 'https://www.uefa.com/match-example',
    });
    assert.equal(fixture.team1, 'Belgium');
    assert.equal(fixture.team2, 'France');
    assert.ok(fixture.competition?.includes('UEFA Nations League'));
    assert.ok(fixture.venue?.includes('King Baudouin Stadium'));
    assert.equal(fixture.city, 'Brussels');
    assert.equal(fixture.date, null, 'даты нет в тексте → null, не выдумываем');
    assert.equal(fixture.sourceUrl, 'https://www.uefa.com/match-example');
    assert.equal(fixture.sourceId, 'keydealer-web-fetch');
  });

  test('ISO-дата в тексте → распознаётся; ничего не выдумывается при пустом тексте', () => {
    const withDate = extractFixtureFromText('Belgium\nFrance\nMatch date: 2026-10-01\n', {
      team1: 'Belgium',
      team2: 'France',
    });
    assert.equal(withDate.date, '2026-10-01');

    const empty = extractFixtureFromText('', {});
    assert.equal(empty.team1, null);
    assert.equal(empty.team2, null);
    assert.equal(empty.date, null);
    assert.equal(empty.competition, null);
    assert.equal(empty.venue, null);
    assert.equal(empty.city, null);
  });
});

// ─────────────── STEP 12: «Team A vs Team B» + pipe-competition ───────────────

describe('STEP 12 T1: реальный формат UEFA', () => {
  test('vs-строка → команды; pipe-title → competition; date остаётся null', () => {
    const content = [
      'Belgium-France | Match info | UEFA Nations League 2027 | UEFA.com',
      '',
      'Belgium vs France',
      '',
      'Updates',
      'Timeline',
      'Line-ups',
      '',
      'King Baudouin Stadium',
      'Brussels',
    ].join('\n');
    const fixture = extractFixtureFromText(content, {
      team1: 'Belgium',
      team2: 'France',
      sourceUrl: 'https://www.uefa.com/match-example',
    });
    assert.equal(fixture.team1, 'Belgium');
    assert.equal(fixture.team2, 'France');
    assert.equal(fixture.competition, 'UEFA Nations League 2027');
    assert.equal(fixture.venue, 'King Baudouin Stadium');
    assert.equal(fixture.city, 'Brussels');
    assert.equal(fixture.date, null, 'даты нет в тексте → null');
    assert.equal(fixture.sourceUrl, 'https://www.uefa.com/match-example');
  });
});

describe('STEP 12 T2: разные регистры vs', () => {
  test('vs / VS / Vs дают одинаковые команды', () => {
    for (const sep of ['vs', 'VS', 'Vs']) {
      const fixture = extractFixtureFromText(`Belgium ${sep} France`, {
        team1: 'Belgium',
        team2: 'France',
      });
      assert.equal(fixture.team1, 'Belgium', `separator: ${sep}`);
      assert.equal(fixture.team2, 'France', `separator: ${sep}`);
    }
  });
});

describe('STEP 12 T3: старый формат продолжает работать', () => {
  test('отдельные строки-команды (бывший P0-формат) не сломаны', () => {
    const fixture = extractFixtureFromText(
      'Belgium\nFrance\nUEFA Nations League\nKing Baudouin Stadium\nBrussels',
      { team1: 'Belgium', team2: 'France' }
    );
    assert.equal(fixture.team1, 'Belgium');
    assert.equal(fixture.team2, 'France');
    assert.ok(fixture.competition?.includes('UEFA Nations League'));
    assert.equal(fixture.venue, 'King Baudouin Stadium');
    assert.equal(fixture.city, 'Brussels');
  });
});

describe('STEP 12 T4: отсутствие vs — ничего не выдумывается', () => {
  test('без контекста команды из отдельных строк не выдумываются', () => {
    const fixture = extractFixtureFromText('Belgium\nFrance', {});
    assert.equal(fixture.team1, null);
    assert.equal(fixture.team2, null);
  });
});

describe('STEP 12 T5: ложные UI labels', () => {
  test('навигационные vs-строки не становятся командами', () => {
    const fixture = extractFixtureFromText('Updates\nTimeline\nLine-ups vs Statistics', {});
    assert.equal(fixture.team1, null);
    assert.equal(fixture.team2, null);
  });
});

describe('STEP 12 T6: competition из pipe-формата', () => {
  test('title-строка → чистый tournament segment', () => {
    const fixture = extractFixtureFromText(
      'Belgium-France | Match info | UEFA Nations League 2027 | UEFA.com',
      {}
    );
    assert.equal(fixture.competition, 'UEFA Nations League 2027');
  });

  test('без надёжного competition → null, не догадка', () => {
    const fixture = extractFixtureFromText('Some page | Match info | UEFA.com', {});
    assert.equal(fixture.competition, null);
  });
});

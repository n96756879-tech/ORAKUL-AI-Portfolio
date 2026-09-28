// STEP 15: offline integration-тесты form-extractor → DataPack.form.
// Сеть полностью замокана (globalThis.fetch / fetchImpl): KeyDealer Web Fetch
// эмулируется synthetic payload'ами. Реальные API не вызываются.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createKeyDealerWebFetcher } from '../src/lib/data/fetchers';
import { resolveDataPack, getSharedDataPackCache, buildMatchCacheKey } from '../src/lib/data/resolver';
import { assembleVdp } from '../src/lib/data/vdp-assembler';
import { MemoryCache } from '../src/lib/data/cache';
import type { DataPack, ProvenancedEntry, TeamFormSnapshot } from '../src/lib/data/types';

function kdFetcherWithContent(content: string, calls: { count: number } = { count: 0 }) {
  const fetchImpl = (async () => {
    calls.count += 1;
    return new Response(
      JSON.stringify({
        url: 'https://www.uefa.com/match-example',
        status: 200,
        content_type: 'text/html',
        title: 'England v Germany',
        content,
        truncated: false,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
  return createKeyDealerWebFetcher({ apiKey: 'kd_live_test', fetchImpl });
}

function resolveWithContent(
  content: string,
  query: { team1: string; team2: string },
  calls?: { count: number },
  cache?: MemoryCache<DataPack>
) {
  return resolveDataPack(
    { team1: query.team1, team2: query.team2, sport: 'football' },
    {
      cache: cache ?? new MemoryCache<DataPack>(),
      keyDealerWebFetcher: kdFetcherWithContent(content, calls),
      sourceUrls: [
        {
          matchKey: buildMatchCacheKey({ team1: query.team1, team2: query.team2, sport: 'football' }),
          url: 'https://www.uefa.com/match-example',
        },
      ],
    }
  );
}

describe('STEP 15 T1: Form попадает в DataPack', () => {
  test('3 матча, W/D/W, goals и opponents корректны', async () => {
    const { dataPack } = await resolveWithContent(
      'England 2-1 Germany\nSpain 1-1 England\nEngland 3-0 Italy',
      { team1: 'England', team2: 'Germany' }
    );
    assert.equal(dataPack.form.length, 3);
    const results = dataPack.form.map((e) => e.data.result);
    assert.deepEqual(results, ['W', 'D', 'W']);
    assert.deepEqual(dataPack.form.map((e) => e.data.goalsFor), [2, 1, 3]);
    assert.deepEqual(dataPack.form.map((e) => e.data.goalsAgainst), [1, 1, 0]);
    assert.deepEqual(dataPack.form.map((e) => e.data.opponent), ['Germany', 'Spain', 'Italy']);
    assert.equal(dataPack.status, 'partial');
  });
});

describe('STEP 15 T2: Provenance сохраняется', () => {
  test('sourceId/sourceUrl-связь/fetchedAt/confidence/confirmed на каждой записи', async () => {
    const { dataPack } = await resolveWithContent(
      'England 2-1 Germany\nSpain 1-1 England',
      { team1: 'England', team2: 'Germany' }
    );
    assert.ok(dataPack.form.length > 0);
    for (const entry of dataPack.form) {
      assert.equal(entry.sourceId, 'keydealer-web-fetch');
      assert.equal(typeof entry.fetchedAt, 'string');
      assert.ok(entry.fetchedAt && entry.fetchedAt.length > 0);
      assert.equal(entry.confidence, 0.95);
      assert.equal(entry.confirmed, true);
      assert.equal(typeof (entry.data as TeamFormSnapshot).team, 'string');
    }
    assert.ok(dataPack.sources.some((s) => s.id === 'keydealer-web-fetch'));
    assert.ok(dataPack.freshness.form, 'freshness.form должен быть установлен');
  });
});

describe('STEP 15 T3: Empty form', () => {
  test('текст без матчей → form=[] и нет исключения', async () => {
    const { dataPack } = await resolveWithContent(
      'Updates\nTimeline\nStats\nLine-ups\nSquad',
      { team1: 'England', team2: 'Germany' }
    );
    assert.equal(dataPack.form.length, 0);
    assert.equal(dataPack.status, 'empty');
  });
});

describe('STEP 15 T4: Fixture + Form из одного текста', () => {
  test('обе секции извлекаются, не мешают друг другу', async () => {
    const content = [
      'Belgium vs France',
      'King Baudouin Stadium',
      'Recent matches',
      'Belgium 2-0 Germany',
      'Spain 1-1 Belgium',
    ].join('\n');
    const { dataPack } = await resolveWithContent(content, { team1: 'Belgium', team2: 'France' });
    assert.ok(dataPack.fixture, 'fixture должен быть извлечён');
    assert.equal(dataPack.fixture?.team1, 'Belgium');
    assert.equal(dataPack.fixture?.team2, 'France');
    assert.equal(dataPack.fixture?.venue, 'King Baudouin Stadium');
    assert.equal(dataPack.form.length, 2);
    assert.deepEqual(dataPack.form.map((e) => e.data.result), ['W', 'D']);
    assert.equal(dataPack.status, 'partial');
  });
});

describe('STEP 15 T5: Unconfirmed записи не проходят assembler', () => {
  test('confirmed=false → skippedUnconfirmed, в чистом виде form пуст', () => {
    const unconfirmed: ProvenancedEntry<TeamFormSnapshot> = {
      data: { team: 'Team A', summary: 'W W D' },
      confirmed: false,
      confidence: 0.5,
      sourceId: 'test-src',
      fetchedAt: '2026-09-27T00:00:00Z',
    };
    const pack: DataPack = {
      fixture: null,
      form: [unconfirmed],
      h2h: [],
      squads: [],
      injuries: [],
      sources: [],
      freshness: {},
      conflicts: [],
      status: 'partial',
    };
    const assembled = assembleVdp(pack);
    assert.equal(assembled.form.length, 0);
    assert.equal(assembled.stats.skippedUnconfirmed, 1);
    assert.equal(assembled.stats.confirmed, 0);
  });
});

describe('STEP 15 T6: Cache содержит Form', () => {
  test('cache hit → тот же DataPack с form, fetcher вызван один раз', async () => {
    const cache = new MemoryCache<DataPack>();
    const calls = { count: 0 };
    const first = await resolveWithContent(
      'England 2-1 Germany\nEngland 3-0 Italy',
      { team1: 'England', team2: 'Germany' },
      calls,
      cache
    );
    assert.equal(first.cacheHit, false);
    assert.equal(calls.count, 1);
    assert.equal(first.dataPack.form.length, 2);

    const second = await resolveDataPack(
      { team1: 'England', team2: 'Germany', sport: 'football' },
      { cache, keyDealerWebFetcher: kdFetcherWithContent('x', calls), sourceUrls: [] }
    );
    assert.equal(second.cacheHit, true);
    assert.equal(calls.count, 1, 'повторной загрузки быть не должно');
    assert.equal(second.dataPack.form.length, 2);
    assert.deepEqual(second.dataPack.form.map((e) => e.data.result), ['W', 'W']);
  });
});

describe('STEP 15: Form без fixture не ломает статус', () => {
  test('form найдена, fixture не извлекается → partial', async () => {
    // Ни vs-строки, ни строк-команд, ни venue — fixture останется null,
    // при этом form-строки валидны.
    const { dataPack } = await resolveWithContent(
      'England 2-1 Germany\nSpain 1-1 England',
      { team1: 'England', team2: 'Germany' }
    );
    assert.equal(dataPack.fixture, null);
    assert.equal(dataPack.form.length, 2);
    assert.equal(dataPack.status, 'partial');
  });
});

// P0-тесты Data Acquisition Layer (STEP 8): cache, health gate, HTTP fetcher,
// VDP assembler, resolver. Полностью offline: реальная сеть не используется,
// fetch инжектируется через fetchImpl (см. package.json test:p0 / test:dal).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryCache, normalizeCacheKey } from '../src/lib/data/cache';
import { createHttpFetcher } from '../src/lib/data/fetchers';
import {
  buildEmptyDataPack,
  isSearchOperational,
  resolveDataPack,
} from '../src/lib/data/resolver';
import { assembleVdp } from '../src/lib/data/vdp-assembler';
import type {
  DataFetcher,
  DataPack,
  DataSource,
  ProvenancedEntry,
} from '../src/lib/data/types';

// ─────────────────────────────── helpers ───────────────────────────────

const SOURCE_A: DataSource = {
  id: 'test-source-a',
  tier: 1,
  name: 'Test Source A',
  reliability: 'official',
  enabled: true,
};

const SOURCE_B: DataSource = {
  id: 'test-source-b',
  tier: 4,
  name: 'Test Source B',
  reliability: 'low',
  enabled: true,
};

function fakeFetcher(source: DataSource): DataFetcher<string> {
  return {
    source,
    supports: () => true,
    fetch: async () => {
      throw new Error('STEP 8 resolver must not call fetchers');
    },
  };
}

function entry<T>(data: T, confirmed: boolean, sourceId = 's1'): ProvenancedEntry<T> {
  return { data, confirmed, confidence: confirmed ? 0.9 : 0.2, sourceId, fetchedAt: '2026-09-27T00:00:00Z' };
}

// ─────────────────────────────── cache ───────────────────────────────

describe('DAL cache', () => {
  test('set/get возвращает значение', () => {
    const cache = new MemoryCache<string>();
    cache.set('key-1', 'value-1');
    assert.equal(cache.get('key-1'), 'value-1');
  });

  test('expiration: просроченный ключ не возвращается', () => {
    const cache = new MemoryCache<string>();
    cache.set('ttl-key', 'ttl-value', 0);
    assert.equal(cache.get('ttl-key'), null);
  });

  test('delete удаляет, clear очищает всё', () => {
    const cache = new MemoryCache<string>();
    cache.set('a', '1');
    cache.set('b', '2');
    assert.equal(cache.delete('a'), true);
    assert.equal(cache.get('a'), null);
    cache.clear();
    assert.equal(cache.get('b'), null);
  });

  test('normalized key: регистр/пробелы/vs-разделитель не влияют', () => {
    const cache = new MemoryCache<string>();
    cache.set('Belgium vs France', 'pack');
    assert.equal(cache.get('belgium VS france'), 'pack');
    assert.equal(cache.get('  BELGIUM   —   France '), 'pack');
    assert.equal(normalizeCacheKey('Belgium vs France'), normalizeCacheKey('belgium VS france'));
    assert.equal(normalizeCacheKey('Belgium — France'), normalizeCacheKey('belgium vs france'));
  });
});

// ─────────────────────────── search health gate ──────────────────────

describe('DAL search health gate', () => {
  test('operational + available → true', () => {
    assert.equal(isSearchOperational({ availability: 'available', status: 'operational' }), true);
  });

  test('elevated + available → false', () => {
    assert.equal(isSearchOperational({ availability: 'available', status: 'elevated' }), false);
  });

  test('operational + review → false', () => {
    assert.equal(isSearchOperational({ availability: 'review', status: 'operational' }), false);
  });

  test('outage → false', () => {
    assert.equal(isSearchOperational({ availability: 'available', status: 'outage' }), false);
    assert.equal(isSearchOperational({ availability: 'review', status: 'outage' }), false);
  });

  test('unknown / null → false', () => {
    assert.equal(isSearchOperational({ availability: 'available', status: 'unknown' }), false);
    assert.equal(isSearchOperational(null), false);
    assert.equal(isSearchOperational(undefined), false);
  });
});

// ───────────────────────────── http fetcher ──────────────────────────

describe('DAL http fetcher (offline, mocked fetchImpl)', () => {
  test('200 → текст, без заголовков авторизации', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenInit = init;
      return new Response('<html>ok</html>', { status: 200 });
    }) as unknown as typeof fetch;

    const fetcher = createHttpFetcher(SOURCE_A, { fetchImpl });
    const result = await fetcher.fetch({ kind: 'page', url: 'https://example.com/match' });

    assert.equal(result.error, null);
    assert.equal(result.data, '<html>ok</html>');
    assert.equal(result.source.id, 'test-source-a');
    assert.ok(result.expiresAt);
    const headers = (seenInit?.headers ?? {}) as Record<string, string>;
    for (const name of Object.keys(headers)) {
      assert.ok(
        !/authorization|x-api-key|cookie|api-key/i.test(name),
        `unexpected auth header: ${name}`
      );
    }
    assert.equal(seenInit?.credentials, 'omit');
  });

  test('HTTP error → error.kind=http, data=null', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const fetcher = createHttpFetcher(SOURCE_B, { fetchImpl });
    const result = await fetcher.fetch({ kind: 'page', url: 'https://example.com/x' });
    assert.equal(result.data, null);
    assert.equal(result.error?.kind, 'http');
    assert.equal(result.error?.status, 500);
  });

  test('timeout → error.kind=timeout (без сети)', async () => {
    const slowFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;

    const fetcher = createHttpFetcher(SOURCE_B, { fetchImpl: slowFetch, timeoutMs: 5_000 });
    const result = await fetcher.fetch({ kind: 'page', url: 'https://example.com/slow', timeoutMs: 30 });
    assert.equal(result.data, null);
    assert.equal(result.error?.kind, 'timeout');
  });

  test('не-http URL отклоняется до fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('should not happen', { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = createHttpFetcher(SOURCE_B, { fetchImpl });
    assert.equal(fetcher.supports({ kind: 'page', url: 'ftp://example.com' }), false);
    const result = await fetcher.fetch({ kind: 'page', url: 'ftp://example.com' });
    assert.equal(result.error?.kind, 'invalid-url');
    assert.equal(called, false);
  });
});

// ───────────────────────────── vdp assembler ─────────────────────────

describe('DAL vdp assembler', () => {
  test('подтверждённые данные проходят, неподтверждённые отбрасываются', () => {
    const pack: DataPack = {
      ...buildEmptyDataPack(),
      form: [entry({ team: 'Belgium', summary: 'W W D' }, true, 'src-a'), entry({ team: 'Fake', summary: 'invented' }, false, 'src-b')],
      h2h: [entry({ date: '2024-06-01', competition: 'EC', score: '2-0', winner: 'Belgium' }, true, 'src-a')],
      squads: [entry({ team: 'Belgium', players: ['A', 'B'] }, true, 'src-a')],
      conflicts: [{ section: 'h2h', field: 'score', message: 'score mismatch', sourceIds: ['src-a', 'src-b'] }],
      status: 'complete',
    };
    const vdp = assembleVdp(pack);
    assert.equal(vdp.form.length, 1);
    assert.equal(vdp.form[0].data.team, 'Belgium');
    assert.equal(vdp.h2h.length, 1);
    assert.equal(vdp.stats.confirmed, 3);
    assert.equal(vdp.stats.skippedUnconfirmed, 1);
    // fixture отсутствует → даже с подтверждёнными секциями статус partial.
    assert.equal(vdp.stats.status, 'partial');
    assert.deepEqual(vdp.provenance.map((p) => p.sourceId), ['src-a', 'src-a', 'src-a']);
    assert.equal(vdp.conflicts.length, 1);
    assert.equal(vdp.conflicts[0].message, 'score mismatch');
  });

  test('отсутствующие данные не выдумываются', () => {
    const vdp = assembleVdp(buildEmptyDataPack());
    assert.equal(vdp.fixture, null);
    assert.equal(vdp.form.length, 0);
    assert.equal(vdp.h2h.length, 0);
    assert.equal(vdp.squads.length, 0);
    assert.equal(vdp.injuries.length, 0);
    assert.equal(vdp.stats.confirmed, 0);
    assert.equal(vdp.stats.status, 'empty');
  });

  test('fixture без секций → partial, source/confidence сохраняются', () => {
    const pack: DataPack = {
      ...buildEmptyDataPack(),
      fixture: { sport: 'football', team1: 'Belgium', team2: 'France', date: null, competition: null, venue: null, city: null, sourceUrl: null, sourceId: null, confidence: null },
      injuries: [entry({ player: 'X', status: 'OUT', asOf: null }, true, 'src-inj')],
    };
    const vdp = assembleVdp(pack);
    // fixture + подтверждённая секция → complete.
    assert.equal(vdp.stats.status, 'complete');    assert.equal(vdp.provenance.length, 1);
    assert.equal(vdp.provenance[0].sourceId, 'src-inj');
    assert.ok(vdp.provenance[0].confidence > 0);
  });
});

// ─────────────────────────────── resolver ────────────────────────────

describe('DAL resolver', () => {
  const QUERY = { team1: 'Belgium', team2: 'France', sport: 'football', date: '2026-10-01' };

  test('cache miss → пустой null-safe DataPack, без fake data', async () => {
    const cache = new MemoryCache<DataPack>();
    const outcome = await resolveDataPack(QUERY, { cache, fetchers: [fakeFetcher(SOURCE_A)] });
    assert.equal(outcome.cacheHit, false);
    assert.deepEqual(outcome.attemptedSourceIds, ['test-source-a']);
    assert.equal(outcome.dataPack.fixture, null);
    assert.equal(outcome.dataPack.form.length, 0);
    assert.equal(outcome.dataPack.h2h.length, 0);
    assert.equal(outcome.dataPack.status, 'empty');
    assert.deepEqual(outcome.dataPack.conflicts, []);
  });

  test('cache hit на повторном запросе и при другом регистре', async () => {
    const cache = new MemoryCache<DataPack>();
    await resolveDataPack(QUERY, { cache });
    const again = await resolveDataPack(QUERY, { cache });
    assert.equal(again.cacheHit, true);
    const upper = await resolveDataPack({ ...QUERY, team1: 'BELGIUM', team2: 'france' }, { cache });
    assert.equal(upper.cacheHit, true);
  });

  test('другая дата → cache miss (новый ключ)', async () => {
    const cache = new MemoryCache<DataPack>();
    await resolveDataPack(QUERY, { cache });
    const other = await resolveDataPack({ ...QUERY, date: '2026-10-02' }, { cache });
    assert.equal(other.cacheHit, false);
  });

  test('без источников → пустой DataPack, ничего не выдумывается', async () => {
    const outcome = await resolveDataPack(QUERY, { cache: new MemoryCache<DataPack>(), fetchers: [] });
    assert.equal(outcome.dataPack.fixture, null);
    assert.deepEqual(outcome.dataPack.sources, []);
    assert.equal(outcome.dataPack.status, 'empty');
  });

  test('disabled источник не попадает в выборку', async () => {
    const disabled: DataSource = { ...SOURCE_B, enabled: false };
    const outcome = await resolveDataPack(QUERY, { cache: new MemoryCache<DataPack>(), fetchers: [fakeFetcher(disabled)] });
    assert.deepEqual(outcome.attemptedSourceIds, []);
    assert.deepEqual(outcome.dataPack.sources, []);
  });
});

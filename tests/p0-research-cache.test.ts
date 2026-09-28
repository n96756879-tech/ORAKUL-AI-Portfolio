import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResearchCacheKey,
  clearResearchCacheForTests,
  getCachedResearch,
  getOrRunResearch,
  hasInFlightResearchForTests,
} from '../src/lib/data/research-cache';

const result = { report: 'VERIFIED DATA PACK', sources: [] };

test.beforeEach(() => clearResearchCacheForTests());

test('C1/C2: normalizes equivalent requests and separates teams', () => {
  assert.equal(
    buildResearchCacheKey({ team1: 'England', team2: 'Spain' }),
    buildResearchCacheKey({ team1: ' england ', team2: '  SPAIN ' }),
  );
  assert.notEqual(
    buildResearchCacheKey({ team1: 'England', team2: 'Spain' }),
    buildResearchCacheKey({ team1: 'England', team2: 'France' }),
  );
});

test('C3-C7: caches successful misses and deduplicates parallel operations', async () => {
  const key = buildResearchCacheKey({ team1: 'England', team2: 'Spain' });
  let calls = 0;
  let release!: (value: typeof result) => void;
  const operation = () => {
    calls += 1;
    return new Promise<typeof result>((resolve) => { release = resolve; });
  };

  const pending = Promise.all([
    getOrRunResearch(key, operation),
    getOrRunResearch(key, operation),
    getOrRunResearch(key, operation),
  ]);
  assert.equal(calls, 1);
  assert.equal(hasInFlightResearchForTests(key), true);
  release(result);
  assert.deepEqual(await pending, [result, result, result]);
  assert.equal(getCachedResearch(key)?.report, result.report);
  assert.equal(hasInFlightResearchForTests(key), false);
  await getOrRunResearch(key, async () => { calls += 1; return result; });
  assert.equal(calls, 1);
});

test('C5/C6: entries hit before TTL and miss after TTL', async () => {
  const key = buildResearchCacheKey({ team1: 'England', team2: 'Spain' });
  await getOrRunResearch(key, async () => result);
  assert.equal(getCachedResearch(key)?.report, result.report);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 30 * 60 * 1000 + 1;
    assert.equal(getCachedResearch(key), null);
  } finally {
    Date.now = originalNow;
  }
});

test('C8-C10: errors are not cached and in-flight state is cleaned', async () => {
  const key = buildResearchCacheKey({ team1: 'England', team2: 'Spain' });
  let calls = 0;
  await assert.rejects(getOrRunResearch(key, async () => {
    calls += 1;
    throw new Error('synthetic research failure');
  }));
  assert.equal(getCachedResearch(key), null);
  assert.equal(hasInFlightResearchForTests(key), false);
  await getOrRunResearch(key, async () => { calls += 1; return result; });
  assert.equal(calls, 2);
});

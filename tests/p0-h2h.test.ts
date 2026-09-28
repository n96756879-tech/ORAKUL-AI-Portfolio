import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { extractH2HFromText } from '../src/lib/data/h2h-extractor';

const extract = (text: string) => extractH2HFromText(text, 'England', 'Spain');

describe('STEP 19 H2H extractor', () => {
  test('extracts scores and winner relative to requested pair', () => {
    assert.equal(extract('England 2-1 Spain')[0].winner, 'England');
    assert.equal(extract('Spain 1-0 England')[0].winner, 'Spain');
    assert.equal(extract('England 0-0 Spain')[0].winner, 'DRAW');
    assert.equal(extract('England 1 - 3 Spain')[0].score, '1-3');
  });

  test('extracts dates before the match', () => {
    assert.equal(extract('20 Sep 2026 — England 2-1 Spain')[0].date, '2026-09-20');
    assert.equal(extract('2026-09-20: England 2-1 Spain')[0].date, '2026-09-20');
  });

  test('supports reversed order and en/em dash separators', () => {
    assert.equal(extract('Spain 0–0 England')[0].winner, 'DRAW');
    assert.equal(extract('Spain 0—1 England')[0].winner, 'England');
  });

  test('rejects no-score and noisy unrelated text', () => {
    const text = [
      'England vs Spain',
      'Stats 2 1',
      'Form W W D L W',
      'standings',
      'navigation labels',
      'team stats',
      'Spain 2-1 France',
      'England 75% Spain',
      'coefficient 2:1',
    ].join('\n');
    assert.deepEqual(extract(text), []);
  });

  test('limits output to ten unique line matches', () => {
    const text = Array.from({ length: 12 }, (_, index) => `England ${index % 3}-${(index + 1) % 3} Spain`).join('\n');
    const matches = extract(text);
    assert.equal(matches.length, 10);
    assert.equal(new Set(matches.map((match) => `${match.date}|${match.score}|${match.winner}`)).size, 3);
    assert.equal(extract('England 2-1 Spain')[0].score, '2-1');
    assert.equal(extract('England 2-1 Spain England 2-1 Spain').length, 0);
  });
});

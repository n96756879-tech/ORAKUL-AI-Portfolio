import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractHistoricalContextFromText } from '../src/lib/data/historical-context-extractor';
import { mergeEngineInput } from '../src/lib/data/engine-bridge';
import type { DataPack } from '../src/lib/data/types';
import type { ParsedVDP } from '../src/lib/vdp-parser';

const source = `### MATCH 1
- **DATE:** 2026-09-20
- **OPPONENT:** Strong FC
- **HOME/AWAY:** HOME
- **SCORE:** 2-1
- **RESULT:** W
- **OPPONENT_STRENGTH:** STRONG

### MATCH 2
- **DATE:** 2026-09-13
- **OPPONENT:** Weak FC
- **HOME/AWAY:** AWAY
- **SCORE:** 0-1
- **RESULT:** L
- **OPPONENT_STRENGTH:** WEAK`;

function emptyVdp(): ParsedVDP {
  return {
    team1: { teamName: 'Alpha', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
    team2: { teamName: 'Beta', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
    h2h: [],
    currentVenue: 'UNKNOWN',
  };
}

function pack(form: DataPack['form']): DataPack {
  return { fixture: { sport: 'football', team1: 'Alpha', team2: 'Beta', date: null, competition: null, venue: 'Upcoming Stadium', city: null, sourceUrl: null, sourceId: null, confidence: 1 }, form, h2h: [], squads: [], injuries: [], sources: [], freshness: {}, conflicts: [], status: 'partial' };
}

describe('STEP 21 historical context', () => {
  test('extracts per-match venue and opponent strength without using upcoming fixture', () => {
    const result = extractHistoricalContextFromText(source, 'Alpha');
    assert.deepEqual(result.map((match) => [match.venue, match.opponentStrength]), [
      ['HOME', 'STRONG'],
      ['AWAY', 'WEAK'],
    ]);
  });

  test('confirmed DataPack fields fill injected matches and preserve fixture venue separation', () => {
    const merged = mergeEngineInput(emptyVdp(), pack([
      { data: { team: 'Alpha', summary: null, opponent: 'Strong FC', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'HOME', opponentStrength: 'STRONG' }, confirmed: true, confidence: 1, sourceId: 'mock', fetchedAt: null },
    ]));
    assert.equal(merged.team1.matches[0]?.venue, 'HOME');
    assert.equal(merged.team1.matches[0]?.opponentStrength, 'STRONG');
    assert.notEqual(merged.team1.matches[0]?.venue, 'Upcoming Stadium');
  });

  test('valid VDP values take precedence over DataPack values', () => {
    const vdp = emptyVdp();
    vdp.team1.matches = [{ date: null, competition: null, opponent: 'VDP FC', venue: 'AWAY', score: '1-0', goalsFor: 1, goalsAgainst: 0, result: 'W', opponentStrength: 'WEAK', source: null, url: null, confidence: '1', penaltyShootout: null }];
    const merged = mergeEngineInput(vdp, pack([{ data: { team: 'Alpha', summary: null, opponent: 'DAL FC', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'HOME', opponentStrength: 'STRONG' }, confirmed: true, confidence: 1, sourceId: 'mock', fetchedAt: null }]));
    assert.equal(merged.team1.matches[0]?.venue, 'AWAY');
    assert.equal(merged.team1.matches[0]?.opponentStrength, 'WEAK');
  });
});

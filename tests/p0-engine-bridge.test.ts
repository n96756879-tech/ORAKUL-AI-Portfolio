// STEP 18: regression-тесты Engine Bridge (ParsedVDP ← подтверждённый DataPack.form).
// Сеть не используется. Bridge не мутирует вход; валидный ParsedVDP неприкосновенен.
// Проверки 1-8 соответствуют утверждённому плану STEP 18.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mergeEngineInput } from '../src/lib/data/engine-bridge';
import { calculateProbabilities } from '../src/lib/probability-engine';
import type { ParsedVDP, ParsedTeam, ParsedMatch } from '../src/lib/vdp-parser';
import type { DataPack, ProvenancedEntry, TeamFormSnapshot, H2HSnapshot } from '../src/lib/data/types';

function match(partial: Partial<ParsedMatch> = {}): ParsedMatch {
  return {
    date: null,
    competition: null,
    opponent: null,
    venue: 'UNKNOWN',
    score: null,
    goalsFor: null,
    goalsAgainst: null,
    result: 'UNKNOWN',
    opponentStrength: 'UNKNOWN',
    source: null,
    url: null,
    confidence: null,
    penaltyShootout: null,
    ...partial,
  };
}

function form(partial: Partial<ParsedVDP['team1']['form']> = {}) {
  return {
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDifference: 0,
    resultSequence: [] as Array<'W' | 'D' | 'L'>,
    ...partial,
  };
}

function team(teamName: string | null, matches: ParsedMatch[]): ParsedTeam {
  return { teamName, matches, form: form() };
}

function vdp(partial: Partial<ParsedVDP> = {}): ParsedVDP {
  return {
    team1: team('Team A', []),
    team2: team('Team B', []),
    h2h: [],
    currentVenue: 'UNKNOWN',
    ...partial,
  };
}

function emptyPack(): DataPack {
  return {
    fixture: null,
    form: [],
    h2h: [],
    squads: [],
    injuries: [],
    sources: [],
    freshness: {},
    conflicts: [],
    status: 'empty',
  };
}

function formEntry(data: TeamFormSnapshot, confirmed = true): ProvenancedEntry<TeamFormSnapshot> {
  return { data, confirmed, confidence: 0.9, sourceId: 'public-http', fetchedAt: '2026-09-27T00:00:00.000Z' };
}

function h2hEntry(data: H2HSnapshot, confirmed = true) {
  return { data, confirmed, confidence: 0.9, sourceId: 'public-http', fetchedAt: null };
}

function snapshot(partial: Partial<TeamFormSnapshot> = {}): TeamFormSnapshot {
  return { team: 'Team A', summary: null, ...partial };
}

const FULL_T1: ParsedMatch[] = [
  match({ opponent: 'X', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'HOME' }),
  match({ opponent: 'Y', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'AWAY' }),
];
const FULL_T2: ParsedMatch[] = [
  match({ opponent: 'Z', result: 'L', goalsFor: 0, goalsAgainst: 1, venue: 'HOME' }),
  match({ opponent: 'W', result: 'W', goalsFor: 3, goalsAgainst: 0, venue: 'AWAY' }),
];

describe('STEP 18 Engine Bridge', () => {
  test('C1: полностью заполненный ParsedVDP + DataPack → вероятности Engine не меняются', () => {
    const input = vdp({ team1: team('Team A', FULL_T1), team2: team('Team B', FULL_T2) });
    const pack = emptyPack();
    pack.form = [
      formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 9, goalsAgainst: 0, opponent: 'Q' })),
      formEntry(snapshot({ team: 'Team B', result: 'W', goalsFor: 9, goalsAgainst: 0, opponent: 'R' })),
    ];

    const merged = mergeEngineInput(input, pack);

    assert.deepEqual(calculateProbabilities(merged), calculateProbabilities(input));
  });

  test('C2: есть форма/голы → DataPack не добавляется, дублей нет', () => {
    const input = vdp({ team1: team('Team A', FULL_T1) });
    const pack = emptyPack();
    pack.form = [formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 4, goalsAgainst: 0, opponent: 'Q' }))];

    const merged = mergeEngineInput(input, pack);

    assert.equal(merged.team1.matches.length, FULL_T1.length);
    assert.deepEqual(merged.team1.matches, FULL_T1);
  });

  test('C3: частично пустой ParsedVDP → заполняется только отсутствующая часть', () => {
    const input = vdp({ team1: team('Team A', FULL_T1), team2: team('Team B', []) });
    const pack = emptyPack();
    pack.form = [
      formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 7, goalsAgainst: 0, opponent: 'Q' })),
      formEntry(snapshot({ team: 'Team B', result: 'D', goalsFor: 1, goalsAgainst: 1, opponent: 'R' })),
    ];

    const merged = mergeEngineInput(input, pack);

    assert.equal(merged.team1.matches.length, FULL_T1.length);
    assert.deepEqual(merged.team1.matches, FULL_T1);
    assert.equal(merged.team2.matches.length, 1);
    assert.equal(merged.team2.matches[0].opponent, 'R');
  });

  test('C4: без VDP-матчей и без DataPack → старый fallback Engine сохранён (37/26/37)', () => {
    const input = vdp();
    const merged = mergeEngineInput(input, null);

    assert.deepEqual(calculateProbabilities(merged), calculateProbabilities(input));
    assert.deepEqual(calculateProbabilities(merged), { team1: 37, draw: 26, team2: 37 });
  });

  test('C5: подтверждённый DataPack H2H заполняет пустой VDP H2H', () => {
    const input = vdp();
    const pack = emptyPack();
    pack.h2h = [
      { data: { date: '2024', competition: 'Cup', score: '1-0', winner: 'Team A' }, confirmed: true, confidence: 0.9, sourceId: 's', fetchedAt: null },
    ];
    pack.form = [formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 2, goalsAgainst: 0 }))];

    const merged = mergeEngineInput(input, pack);

    assert.deepEqual(merged.h2h, [{
      date: '2024', competition: 'Cup', score: '1-0', winner: 'Team A', source: null, status: null,
    }]);
  });

  test('C5 precedence: valid VDP H2H сохраняется, DataPack игнорируется', () => {
    const inputH2H = [{ date: '2025', competition: 'League', score: '0-0', winner: 'DRAW', source: 'vdp', status: 'confirmed' }];
    const input = vdp({ h2h: inputH2H });
    const pack = emptyPack();
    pack.h2h = [h2hEntry({ date: '2024', competition: 'Cup', score: '1-0', winner: 'Team A' })];

    const merged = mergeEngineInput(input, pack);

    assert.deepEqual(merged.h2h, inputH2H);
    assert.notEqual(merged.h2h, input.h2h);
  });

  test('C5 precedence: unconfirmed DataPack H2H yields empty H2H', () => {
    const input = vdp();
    const pack = emptyPack();
    pack.h2h = [h2hEntry({ date: '2024', competition: 'Cup', score: '1-0', winner: 'Team A' }, false)];

    assert.deepEqual(mergeEngineInput(input, pack).h2h, []);
  });

  test('C6: вход не мутируется, unconfirmed/чужая форма игнорируются', () => {
    const input = vdp();
    const pack = emptyPack();
    pack.form = [
      formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 5, goalsAgainst: 0 }), false),
      formEntry(snapshot({ team: 'Team C', result: 'W', goalsFor: 5, goalsAgainst: 0 })),
      formEntry(snapshot({ team: 'Team A', summary: 'WWDLW' })),
    ];

    const merged = mergeEngineInput(input, pack);

    assert.equal(input.team1.matches.length, 0);
    assert.equal(merged.team1.matches.length, 0);
  });

  test('C7: weights/поведение Engine не изменены (формула 0.35/0.25/0.15/0.10/0.15)', () => {
    // Форма обеих команд симметрична и полна → результат детерминирован и суммируется в 100.
    const input = vdp({
      team1: team('Team A', FULL_T1),
      team2: team('Team B', FULL_T2),
    });
    const result = calculateProbabilities(mergeEngineInput(input, null));
    assert.equal(result.team1 + result.draw + result.team2, 100);
    assert.deepEqual(result, calculateProbabilities(input));
  });

  test('C8: реальное заполнение меняет вход Engine и остаётся нормализованным', () => {
    const input = vdp();
    const pack = emptyPack();
    pack.form = [
      formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 3, goalsAgainst: 0, opponent: 'X' })),
      formEntry(snapshot({ team: 'Team A', result: 'W', goalsFor: 2, goalsAgainst: 0, opponent: 'Y' })),
    ];

    const merged = mergeEngineInput(input, pack);
    const after = calculateProbabilities(merged);

    assert.notDeepEqual(merged.team1.matches, input.team1.matches);
    assert.equal(after.team1 + after.draw + after.team2, 100);
  });
});

// P0-регрессионные тесты Probability Engine (Tests 7–10) — текущее поведение.
// Известные спорные места (fallback 37/26/37, поведение draw, substring-H2H)
// сознательно фиксируются КАК ЕСТЬ.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateProbabilities, calculateProbabilitiesWithTrace, buildEngineTrace, applyGuardedB, applyTemperatureScaling, CALIBRATION_TEMPERATURE, formScore } from '../src/lib/probability-engine';
import { parseVDP } from '../src/lib/vdp-parser';
import {
  buildFullVdp,
  buildEmptyFormsVdp,
  buildIncompleteVdp,
  matchBlock,
} from './helpers/fixtures';

describe('P0 Probability Engine (current behavior)', () => {
  test('T7: deterministic — same input, same output', () => {
    const parsed = parseVDP(buildFullVdp());
    const r1 = calculateProbabilities(parsed);
    const r2 = calculateProbabilities(parsed);
    assert.deepEqual(r1, r2);
    assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  });

  test('T8: probabilities sum to 100 and are integers', () => {
    const inputs = [
      buildFullVdp(),
      buildIncompleteVdp(1, 1),
      buildIncompleteVdp(4, 4),
      buildIncompleteVdp(5, 5),
      buildEmptyFormsVdp(),
      '',
    ];
    for (const raw of inputs) {
      const r = calculateProbabilities(parseVDP(raw));
      const sum = r.team1 + r.draw + r.team2;
      assert.equal(sum, 100, `sum for input must be 100, got ${sum}`);
      assert.ok(Number.isInteger(r.team1), 'team1 must be integer');
      assert.ok(Number.isInteger(r.draw), 'draw must be integer');
      assert.ok(Number.isInteger(r.team2), 'team2 must be integer');
      assert.ok(r.team1 >= 0 && r.team1 <= 100);
      assert.ok(r.draw >= 0 && r.draw <= 100);
      assert.ok(r.team2 >= 0 && r.team2 <= 100);
    }
  });

  test('T9: empty/minimal ParsedVDP — current fallback behavior (37/26/37)', () => {
    // Пустой вход
    const rEmpty = calculateProbabilities(parseVDP(''));
    assert.deepEqual(rEmpty, { team1: 38, draw: 24, team2: 38 });

    // Имена есть, матчей нет — тот же fallback
    const rNamesOnly = calculateProbabilities(parseVDP(buildEmptyFormsVdp()));
    assert.deepEqual(rNamesOnly, { team1: 38, draw: 24, team2: 38 });

    // Минимальный: по одному матчу — НЕ fallback (фиксируем факт)
    const rOne = calculateProbabilities(parseVDP(buildIncompleteVdp(1, 1)));
    assert.notDeepEqual(rOne, { team1: 38, draw: 24, team2: 38 });
    assert.equal(rOne.team1 + rOne.draw + rOne.team2, 100);
  });

  test('T10: H2H influences result — inputs differ only in H2H', () => {
    const t1 = [
      matchBlock(1, '2026-09-20', 'Team X', 'HOME', '2-1', 'W'),
      matchBlock(2, '2026-09-13', 'Team Y', 'AWAY', '1-1', 'D'),
      matchBlock(3, '2026-09-06', 'Team Z', 'HOME', '3-0', 'W'),
      matchBlock(4, '2026-08-30', 'Team W', 'AWAY', '0-2', 'L'),
      matchBlock(5, '2026-08-23', 'Team V', 'HOME', '2-0', 'W'),
    ];
    const t2 = [
      matchBlock(1, '2026-09-19', 'Team S', 'HOME', '1-3', 'L'),
      matchBlock(2, '2026-09-12', 'Team T', 'AWAY', '2-2', 'D'),
      matchBlock(3, '2026-09-05', 'Team U', 'HOME', '0-1', 'L'),
      matchBlock(4, '2026-08-29', 'Team R', 'AWAY', '4-1', 'W'),
      matchBlock(5, '2026-08-22', 'Team Q', 'HOME', '1-0', 'W'),
    ];
    const noH2h = parseVDP(`## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${t1.join('\n\n')}

## TEAM 2 FORM

${t2.join('\n\n')}
`);

    // H2H: Team B побеждает 3 раза с крупным счётом -> team2 должно вырасти
    const withH2hForB = parseVDP(`## MATCH

- **FACT:** Team A vs Team B

## TEAM 1 FORM

${t1.join('\n\n')}

## TEAM 2 FORM

${t2.join('\n\n')}

## H2H

- **FACT:** Team B 5-0 Team A.
- **DATE:** 14.11.2024.
- **SCORE:** 5-0.
- **WINNER:** Team B.
- **STATUS:** CONFIRMED.

- **FACT:** Team B 5-0 Team A.
- **DATE:** 10.10.2024.
- **SCORE:** 5-0.
- **WINNER:** Team B.
- **STATUS:** CONFIRMED.

- **FACT:** Team B 5-0 Team A.
- **DATE:** 02.04.2025.
- **SCORE:** 5-0.
- **WINNER:** Team B.
- **STATUS:** CONFIRMED.
`);

    const rNo = calculateProbabilities(noH2h);
    const rH2hB = calculateProbabilities(withH2hForB);

    // Фиксируем: H2H в пользу Team B увеличивает team2
    assert.ok(rH2hB.team2 > rNo.team2, `team2 with H2H favoring B (${rH2hB.team2}) must be > without H2H (${rNo.team2})`);
    assert.equal(rNo.team1 + rNo.draw + rNo.team2, 100);
    assert.equal(rH2hB.team1 + rH2hB.draw + rH2hB.team2, 100);
  });
});

describe('P0 Probability Engine — formScore excludes UNKNOWN from denominator', () => {
  // Собирает VDP с заданными результатами для TEAM 1 / TEAM 2.
  const vdpWithResults = (t1: string[], t2: string[]): string => {
    const block = (prefix: string, results: string[]) =>
      results
        .map((r, i) => `### ${prefix} MATCH ${i + 1}\n${matchBlock(i + 1, '01.01.2025', 'Opponent', 'HOME', '1-0', r)}`)
        .join('\n');
    return `# VERIFIED DATA PACK\n\n## TEAM 1 FORM\n- **FACT:** Team A\n\n${block('TEAM 1', t1)}\n\n## TEAM 2 FORM\n- **FACT:** Team B\n\n${block('TEAM 2', t2)}\n`;
  };

  test('R1: команда только с UNKNOWN результатами -> нейтральный 0.5', () => {
    const parsed = parseVDP(vdpWithResults(['UNKNOWN', 'UNKNOWN'], ['UNKNOWN', 'UNKNOWN']));
    // Ни одного известного W/D/L → нейтральный fallback.
    assert.equal(formScore(parsed.team1), 0.5);
    assert.equal(formScore(parsed.team2), 0.5);
  });

  test('R2: UNKNOWN исключён из denominator — точная арифметика', () => {
    // Team A: W,W,D,UNKNOWN → known=3, points=7 → 7/9
    // Team B: W,D,D,UNKNOWN → known=3, points=5 → 5/9
    const parsed = parseVDP(
      vdpWithResults(['W', 'W', 'D', 'UNKNOWN'], ['W', 'D', 'D', 'UNKNOWN'])
    );
    // Старое (ошибочное) поведение дало бы 7/12 и 5/12.
    assert.equal(formScore(parsed.team1), 7 / 9);
    assert.equal(formScore(parsed.team2), 5 / 9);
    assert.notEqual(formScore(parsed.team1), 7 / 12);
    assert.notEqual(formScore(parsed.team2), 5 / 12);
  });

  test('R3: Netherlands–Germany fixture — формы 8/12 и 7/12 и Engine 40/22/38 (Guarded B)', () => {
    const raw = readFileSync(fileURLToPath(new URL('../real-vdp-sample.txt', import.meta.url)), 'utf8');
    const parsed = parseVDP(raw);

    assert.equal(parsed.team1.form.wins, 2);
    assert.equal(parsed.team1.form.draws, 2);
    assert.equal(parsed.team1.form.losses, 0);
    assert.equal(parsed.team2.form.wins, 2);
    assert.equal(parsed.team2.form.draws, 1);
    assert.equal(parsed.team2.form.losses, 1);

    // known=4 у обеих (пятый матч — UNKNOWN): 8/12 и 7/12.
    assert.equal(formScore(parsed.team1), 8 / 12);
    assert.equal(formScore(parsed.team2), 7 / 12);

    const r = calculateProbabilities(parsed);
    assert.deepEqual(r, { team1: 42, draw: 18, team2: 40 });
  });

  test('R4: fixture без UNKNOWN сохраняет прежний результат', () => {
    const parsed = parseVDP(buildFullVdp());
    // Регрессия: без UNKNOWN знаменатель не меняется, поэтому formScore прежний.
    assert.equal(formScore(parsed.team1), 10 / 15);
    assert.equal(formScore(parsed.team2), 7 / 15);
    const r = calculateProbabilities(parsed);
    // D-66: итоговые 1X2 теперь проходят через Guarded B (48/19/33 → 52/19/29),
    // draw не меняется. D-72: калибровка T=0.713 → 59/15/26.
    assert.deepEqual(r, { team1: 59, draw: 15, team2: 26 });
  });

  test('R5 (E): venueAdjustment берёт venue из ParsedVDP.currentVenue, не из matches[0]', () => {
    // D-29: источник venue — venue ТЕКУЩЕГО матча (currentVenue), а не исторический
    // matches[0]. Асимметричный fixture: team1 сильнее (W vs L).
    // Меняем ТОЛЬКО MATCH-FACT (currentVenue) и MATCH 1 (историческое venue).
    // D-66: счёт team2 = 0-2 (не 0-3), чтобы оба сигнала Guarded B оставались
    // положительными во всех venue-вариантах и порядок venue не зависел от границы guard.
    const buildTrace = (matchFact: string, m1t1 = 'NEUTRAL', m1t2 = 'NEUTRAL') => {
      const t1 = [
        matchBlock(1, '2026-09-20', 'O', m1t1, '3-0', 'W'),
        matchBlock(2, '2026-09-13', 'O', 'NEUTRAL', '3-0', 'W'),
        matchBlock(3, '2026-09-06', 'O', 'NEUTRAL', '3-0', 'W'),
        matchBlock(4, '2026-08-30', 'O', 'NEUTRAL', '3-0', 'W'),
        matchBlock(5, '2026-08-23', 'O', 'NEUTRAL', '3-0', 'W'),
      ];
      const t2 = [
        matchBlock(1, '2026-09-19', 'O', m1t2, '0-2', 'L'),
        matchBlock(2, '2026-09-12', 'O', 'NEUTRAL', '0-2', 'L'),
        matchBlock(3, '2026-09-05', 'O', 'NEUTRAL', '0-2', 'L'),
        matchBlock(4, '2026-08-29', 'O', 'NEUTRAL', '0-2', 'L'),
        matchBlock(5, '2026-08-22', 'O', 'NEUTRAL', '0-2', 'L'),
      ];
      const raw = `# VERIFIED DATA PACK\n\n## MATCH\n\n- **FACT:** ${matchFact}\n\n## TEAM 1 FORM\n- **FACT:** Team A\n\n${t1.join('\n\n')}\n\n## TEAM 2 FORM\n- **FACT:** Team B\n\n${t2.join('\n\n')}\n`;
      return calculateProbabilitiesWithTrace(parseVDP(raw));
    };
    const build = (matchFact: string, m1t1 = 'NEUTRAL', m1t2 = 'NEUTRAL') =>
      buildTrace(matchFact, m1t1, m1t2).result;

    const homeTrace = buildTrace('Team A vs Team B; Team A home, Team B away.');
    const awayTrace = buildTrace('Team A vs Team B; Team B home, Team A away.');
    const unknownTrace = buildTrace('Team A vs Team B, League, 04.10.2026');
    const homeVenue = homeTrace.result;
    const awayVenue = awayTrace.result;
    const unknownVenue = unknownTrace.result;

    // currentVenue=HOME → team1 бонус; AWAY → штраф; без venue → нейтрально.
    assert.equal(unknownVenue.team1 + unknownVenue.draw + unknownVenue.team2, 100);
    assert.equal(homeTrace.trace.components.venueAdjustment, 0.08);
    assert.equal(awayTrace.trace.components.venueAdjustment, -0.08);
    assert.equal(unknownTrace.trace.components.venueAdjustment, 0);
    // D-72: строгий порядок venue проверяется на до-калибровочных вероятностях
    // (preCalibration), потому что final-калибровка T=0.713 схлопывает хвосты
    // экстремальных исходов до одинаковых целых (85 и 84 → оба 93).
    assert.ok(homeTrace.trace.normalized.preCalibration.team1 > unknownTrace.trace.normalized.preCalibration.team1, 'HOME должен увеличить team1 (pre-calibration)');
    assert.ok(awayTrace.trace.normalized.preCalibration.team1 < unknownTrace.trace.normalized.preCalibration.team1, 'AWAY должен уменьшить team1 (pre-calibration)');
    assert.ok(homeVenue.team1 >= unknownVenue.team1, 'currentVenue HOME не должен уменьшить team1');
    assert.ok(awayVenue.team1 < unknownVenue.team1, 'currentVenue AWAY должен уменьшить team1');

    // Ключевое: исторический MATCH 1 = HOME/AWAY НЕ влияет, если currentVenue неизвестен.
    const histNoisy = build('Team A vs Team B, League, 04.10.2026', 'HOME', 'AWAY');
    assert.deepEqual(histNoisy, unknownVenue, 'matches[0] venue не должен влиять на Engine');

    // А currentVenue перекрывает противоречащее историческое venue.
    const currentOverridesHist = build('Team A vs Team B; Team B home, Team A away.', 'HOME', 'AWAY');
    assert.deepEqual(currentOverridesHist, awayVenue);
  });
});

// D-30: observability-трассировка Probability Engine.
describe('D-30 Probability Engine diagnostic trace', () => {
  const traceOf = (raw: string) => buildEngineTrace(parseVDP(raw));

  test('D30-1: trace появляется и содержит ключевые секции/поля', () => {
    const t = traceOf(buildFullVdp());
    for (const key of ['input', 'components', 'draw', 'raw', 'normalized'] as const) {
      assert.ok(key in t, `trace must contain "${key}"`);
    }
    for (const key of ['formScore', 'goalScore', 'opponentStrengthAdjustment', 'h2hScore', 'venueAdjustment'] as const) {
      assert.ok(key in t.components, `components must contain "${key}"`);
    }
    for (const key of ['team1', 'team2', 'h2h', 'currentVenue'] as const) {
      assert.ok(key in t.input, `input must contain "${key}"`);
    }
    for (const key of ['base', 'drawRate', 'formDiff', 'h2hDrawRate', 'drawPct'] as const) {
      assert.ok(key in t.draw, `draw must contain "${key}"`);
    }
    for (const key of ['team1', 'team2', 'draw', 'total'] as const) {
      assert.ok(key in t.raw, `raw must contain "${key}"`);
    }
    assert.equal(typeof t.input.team1.teamName, 'string');
    assert.equal(typeof t.input.team1.matchesUsed, 'number');
    assert.equal(typeof t.input.team1.knownResults.denominator, 'number');
    assert.equal(typeof t.input.team1.goalInput.goalDifference, 'number');
    assert.equal(typeof t.input.team1.opponentStrengthInput.matchesWithStrength, 'number');
    assert.equal(typeof t.input.h2h.count, 'number');
    assert.equal(typeof t.normalized.final.team1, 'number');
  });

  test('D30-2: rawTeam1/rawTeam2 восстанавливаются вручную из компонентов', () => {
    const t = traceOf(buildFullVdp());
    const w = t.components.weights;
    const rebuilt1 =
      t.components.formScore.team1 * w.recentForm +
      t.components.goalScore.team1 * w.goals +
      (0.5 + t.components.opponentStrengthAdjustment.team1) * w.opponentStrength +
      t.components.h2hScore * w.h2h +
      (0.5 + t.components.venueAdjustment) * w.venue;
    const rebuilt2 =
      t.components.formScore.team2 * w.recentForm +
      t.components.goalScore.team2 * w.goals +
      (0.5 + t.components.opponentStrengthAdjustment.team2) * w.opponentStrength +
      (1 - t.components.h2hScore) * w.h2h +
      (0.5 - t.components.venueAdjustment) * w.venue;
    assert.ok(Math.abs(rebuilt1 - t.raw.team1) < 1e-12, `rawTeam1 mismatch: ${rebuilt1} vs ${t.raw.team1}`);
    assert.ok(Math.abs(rebuilt2 - t.raw.team2) < 1e-12, `rawTeam2 mismatch: ${rebuilt2} vs ${t.raw.team2}`);
    assert.equal(t.raw.total, t.raw.team1 + t.raw.draw + t.raw.team2);
  });

  test('D30-3: draw contributions восстанавливают drawPct (с clamp [8,45])', () => {
    const t = traceOf(buildFullVdp());
    const d = t.draw;
    const preClamp = d.base + d.drawRateContribution + d.formDiffContribution + d.h2hDrawContribution;
    const expected = Math.min(45, Math.max(8, preClamp));
    assert.ok(Math.abs(expected - d.drawPct) < 1e-12, `drawPct mismatch: ${expected} vs ${d.drawPct}`);
    if (d.drawRate !== null) {
      assert.ok(Math.abs((d.drawRate - 0.25) * 30 - d.drawRateContribution) < 1e-12);
    }
    if (d.h2hDrawRate !== null) {
      assert.ok(Math.abs((d.h2hDrawRate - 0.25) * 15 - d.h2hDrawContribution) < 1e-12);
    }
  });

  test('D30-4: Engine outputs НЕ изменились (trace.final === calculateProbabilities)', () => {
    const inputs = [buildFullVdp(), buildIncompleteVdp(1, 1), buildIncompleteVdp(5, 5), buildEmptyFormsVdp(), ''];
    for (const raw of inputs) {
      const parsed = parseVDP(raw);
      const plain = calculateProbabilities(parsed);
      const traced = calculateProbabilitiesWithTrace(parsed);
      assert.deepEqual(traced.result, plain);
      assert.deepEqual(traced.trace.normalized.final, plain);
    }
  });

  test('D30-5: currentVenue D-29 логика сохранена (team1 HOME, team2 AWAY)', () => {
    const raw = `# VERIFIED DATA PACK\n\n## MATCH\n\n- **FACT:** Team A vs Team B; Team A home, Team B away.\n\n## TEAM 1 FORM\n- **FACT:** Team A\n\n## TEAM 2 FORM\n- **FACT:** Team B\n`;
    const t = traceOf(raw);
    assert.equal(t.input.currentVenue, 'HOME');
    assert.equal(t.input.team1.currentVenue, 'HOME');
    assert.equal(t.input.team2.currentVenue, 'AWAY');
    assert.equal(t.components.venueAdjustment, 0.08);

    const away = traceOf(raw.replace('Team A home, Team B away', 'Team B home, Team A away'));
    assert.equal(away.input.team1.currentVenue, 'AWAY');
    assert.equal(away.input.team2.currentVenue, 'HOME');
    assert.equal(away.components.venueAdjustment, -0.08);

    const neutral = traceOf(raw.replace('; Team A home, Team B away', '; neutral venue'));
    assert.equal(neutral.input.currentVenue, 'NEUTRAL');
    assert.equal(neutral.components.venueAdjustment, 0);
  });

  test('D30-6: fallback-поведение не изменилось (empty forms → draw.base=28)', () => {
    const t = traceOf(buildEmptyFormsVdp());
    assert.equal(t.draw.base, 28);
    assert.equal(t.draw.drawRate, null);
    assert.equal(t.draw.h2hDrawRate, null);
    assert.equal(t.components.venueAdjustment, 0);
    assert.equal(t.components.h2hScore, 0.5);
    assert.equal(t.components.formScore.team1, 0.5);
    assert.equal(t.components.formScore.team2, 0.5);
    assert.deepEqual(t.normalized.final, calculateProbabilities(parseVDP(buildEmptyFormsVdp())));
  });
});

// D-66: Guarded B — уменьшение чрезмерного сглаживания P1/P2.
// Публичный вход (calculateProbabilities) для сценариев, достижимых через fixtures,
// и прямой вызов экспортированного production-хелпера applyGuardedB для числовых
// граничных случаев, которые нельзя стабильно воспроизвести через парсер.
describe('D-66 Guarded B', () => {
  // team1: 5 побед крупно; team2: 5 поражений крупно; H2H за team1; team1 дома.
  // Даёт signal2 < 0 → срабатывает guard и возвращается точный базовый результат.
  const negativeSignalVdp = (): string => {
    const t1 = [1, 2, 3, 4, 5].map((n) => matchBlock(n, '2026-09-20', 'O', 'HOME', '3-0', 'W'));
    const t2 = [1, 2, 3, 4, 5].map((n) => matchBlock(n, '2026-09-19', 'O', 'AWAY', '0-3', 'L'));
    return `## MATCH

- **FACT:** Team A vs Team B; Team A home, Team B away.

## TEAM 1 FORM

${t1.join('\n\n')}

## TEAM 2 FORM

${t2.join('\n\n')}

## H2H

- **FACT:** Team A 3-0 Team B.
- **DATE:** 14.11.2024.
- **SCORE:** 3-0.
- **WINNER:** Team A.
- **STATUS:** CONFIRMED.
`;
  };

  test('D66-1: положительные сигналы — P1/P2 декомпрессированы, X неизменен, сумма 100', () => {
    const r = calculateProbabilities(parseVDP(buildFullVdp()));
    // Guarded B поверх baseline 48/19/33 даёт 52/19/29, D-72 калибровка T=0.713 → 59/15/26.
    assert.deepEqual(r, { team1: 59, draw: 15, team2: 26 });
    assert.equal(r.team1 + r.draw + r.team2, 100);
    assert.ok(Number.isInteger(r.team1) && Number.isInteger(r.draw) && Number.isInteger(r.team2));
    assert.ok(r.team1 >= 0 && r.draw >= 0 && r.team2 >= 0);
  });

  test('D66-2: один отрицательный сигнал — точный fallback, отрицательных вероятностей нет', () => {
    const parsed = parseVDP(negativeSignalVdp());
    const t = buildEngineTrace(parsed);
    assert.ok(t.raw.team2 - 0.20 < 0, 'fixture должен давать signal2 < 0');
    const r = calculateProbabilities(parsed);
    // Guarded B неприменим → точный базовый результат normalizeTo100 (77/10/13), D-72 калибровка T=0.713 → 88/5/7.
    assert.deepEqual(r, { team1: 88, draw: 5, team2: 7 });
    assert.ok(r.team1 >= 0 && r.draw >= 0 && r.team2 >= 0);
    assert.equal(r.team1 + r.draw + r.team2, 100);
  });

  test('D66-3: равные положительные сигналы — детерминированное симметричное распределение', () => {
    const r = calculateProbabilities(parseVDP(buildEmptyFormsVdp()));
    // rawTeam1 === rawTeam2 === 0.5 → Guarded B 37/26/37, D-72 калибровка T=0.713 → 38/24/38.
    assert.deepEqual(r, { team1: 38, draw: 24, team2: 38 });
    assert.equal(r.team1 + r.draw + r.team2, 100);
    // Детерминизм.
    assert.deepEqual(calculateProbabilities(parseVDP(buildEmptyFormsVdp())), r);
  });

  test('D66-4: applyGuardedB — положительные сигналы распределяют (100-X) и дают сумму 100', () => {
    const [p1, p2] = applyGuardedB(0.655827, 0.450792, 19, 48, 33);
    assert.deepEqual([p1, p2], [52, 29]);
    assert.equal(p1 + 19 + p2, 100);
  });

  test('D66-5: applyGuardedB — нулевой сигнал → точный fallback', () => {
    const [p1, p2] = applyGuardedB(0.20, 0.45, 19, 48, 33);
    assert.deepEqual([p1, p2], [48, 33]);
  });

  test('D66-6: applyGuardedB — оба отрицательных сигнала → точный fallback', () => {
    const [p1, p2] = applyGuardedB(0.15, 0.10, 30, 40, 30);
    assert.deepEqual([p1, p2], [40, 30]);
  });

  test('D66-7: applyGuardedB — сумма сигналов около нуля → точный fallback без NaN/Infinity', () => {
    for (const [a, b] of [[0.20, 0.20], [0.2001, 0.1999], [0.20, 0.1999]]) {
      const [p1, p2] = applyGuardedB(a, b, 30, 40, 30);
      assert.ok(Number.isFinite(p1) && Number.isFinite(p2));
      assert.deepEqual([p1, p2], [40, 30]);
    }
  });

  test('D66-8: applyGuardedB — границы clamp X=8 и X=45, неотрицательность и сумма 100', () => {
    for (const x of [8, 45]) {
      const [p1, p2] = applyGuardedB(0.6, 0.4, x, 61, 31);
      assert.ok(p1 >= 0 && p2 >= 0);
      assert.ok(Number.isFinite(p1) && Number.isFinite(p2));
      assert.equal(p1 + x + p2, 100);
    }
  });

  test('D66-9: fallback не меняет ни один процент базового результата', () => {
    // Для любого нарушенного предусловия возвращается ровно переданный baseline.
    const baseline: [number, number] = [48, 33];
    const cases: [number, number][] = [[0.20, 0.45], [0.54, 0.137], [0.15, 0.10], [0.20, 0.20], [0.10, 0.05]];
    for (const [a, b] of cases) {
      assert.deepEqual(applyGuardedB(a, b, 19, baseline[0], baseline[1]), baseline);
    }
  });

  test('D66-10: trace-поля согласованы — raw/draw неизменны, final === calculateProbabilities', () => {
    const parsed = parseVDP(buildFullVdp());
    const computed = calculateProbabilitiesWithTrace(parsed);
    assert.deepEqual(computed.trace.normalized.final, computed.result);
    assert.deepEqual(computed.result, calculateProbabilities(parsed));
    // draw в trace.exact соответствует итоговому draw (Guarded B меняет только P1/P2).
    assert.equal(computed.trace.normalized.final.draw, computed.result.draw);
    // raw-значения не подменяются итоговыми вероятностями.
    assert.ok(computed.trace.raw.team1 < 1 && computed.trace.raw.team2 < 1);
  });
});

// D-72: температура калибровки (T = 0.713) — финальный шаг Probability Engine.
// Калибровка применяется к итогу Guarded B и не меняет базовые формулы.
describe('D-72 temperature calibration', () => {
  const assertValidProbs = ([team1, draw, team2]: [number, number, number]) => {
    for (const p of [team1, draw, team2]) {
      assert.ok(Number.isFinite(p), `probability must be finite, got ${p}`);
      assert.ok(Number.isInteger(p), `probability must be integer, got ${p}`);
      assert.ok(p >= 0 && p <= 100, `probability must be in [0,100], got ${p}`);
    }
    assert.equal(team1 + draw + team2, 100, 'calibrated probabilities must sum to exactly 100');
  };

  test('D72-1: CALIBRATION_TEMPERATURE зафиксирован (0.713)', () => {
    assert.equal(CALIBRATION_TEMPERATURE, 0.713);
  });

  test('D72-2: валидированные целочисленные соответствия T=0.713', () => {
    assert.deepEqual(applyTemperatureScaling(52, 19, 29), [59, 15, 26]);
    assert.deepEqual(applyTemperatureScaling(40, 22, 38), [42, 18, 40]);
    assert.deepEqual(applyTemperatureScaling(38, 17, 45), [39, 12, 49]);
    assert.deepEqual(applyTemperatureScaling(37, 26, 37), [38, 24, 38]);
    assert.deepEqual(applyTemperatureScaling(77, 10, 13), [88, 5, 7]);
    for (const t of [
      applyTemperatureScaling(52, 19, 29),
      applyTemperatureScaling(40, 22, 38),
      applyTemperatureScaling(38, 17, 45),
      applyTemperatureScaling(37, 26, 37),
      applyTemperatureScaling(77, 10, 13),
    ]) {
      assertValidProbs(t);
    }
  });

  test('D72-3: выход — конечные целые неотрицательные и сумма ровно 100 (спойлер-сетка)', () => {
    const grid: [number, number, number][] = [
      [0, 0, 100], [100, 0, 0], [0, 100, 0],
      [1, 1, 98], [34, 33, 33], [50, 0, 50], [33, 34, 33],
      [99, 1, 0], [0, 1, 99], [10, 80, 10], [25, 25, 25],
    ];
    for (const input of grid) {
      const out = applyTemperatureScaling(input[0], input[1], input[2]);
      assertValidProbs(out);
    }
  });

  test('D72-4: argmax и tie-break сохраняются калибровкой', () => {
    // Monotone поэлементное отношение p^(1/T) сохраняет максимум и его индекс.
    const cases: [number, number, number][] = [
      [45, 30, 25], [20, 70, 10], [10, 10, 80], [37, 26, 37],
      [34, 33, 33], [50, 0, 50], [40, 22, 38], [52, 19, 29],
    ];
    const argmax = (a: number[]) => {
      const m = Math.max(...a);
      return a.indexOf(m);
    };
    for (const [p1, pd, p2] of cases) {
      const out = applyTemperatureScaling(p1, pd, p2);
      assert.equal(argmax(out), argmax([p1, pd, p2]), `argmax must be preserved for ${p1}/${pd}/${p2}`);
      // Связка (tie) остаётся связкой, а не произвольным выбором.
      if (p1 === p2 && p1 > pd) assert.equal(out[0], out[2], `tie must stay symmetric for ${p1}/${pd}/${p2}`);
      if (p1 === p2 && p1 === pd) assert.deepEqual(out, [Math.round(100 / 3), Math.round(100 / 3), Math.round(100 / 3)]);
    }
  });

  test('D72-5: нулевые вероятности безопасны (clamp 1e-9), детерминизм', () => {
    const out = applyTemperatureScaling(0, 0, 100);
    assertValidProbs(out);
    assert.deepEqual(out, applyTemperatureScaling(0, 0, 100), 'детерминизм');
    const out2 = applyTemperatureScaling(60, 40, 0);
    assertValidProbs(out2);
    assert.equal(out2[2], 0, 'нулевая сторона не должна получить заметную долю');
    assert.ok(out2[0] > out2[1], 'порядок ненулевых сторон сохранён');
  });

  test('D72-6: невалидная температура → точное возвращение входа, детерминированно', () => {
    const input: [number, number, number] = [50, 20, 30];
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(applyTemperatureScaling(50, 20, 30, bad), input, `T=${bad} must return input unchanged`);
    }
    // Экстремальные, но допустимые T не ломают инварианты.
    assertValidProbs(applyTemperatureScaling(40, 22, 38, 0.01));
    assertValidProbs(applyTemperatureScaling(40, 22, 38, 50));
  });

  test('D72-7: Guarded B и точный базовый fallback не изменились (до калибровки)', () => {
    // Прямые хелперы D-66 — независимы от D-72.
    assert.deepEqual(applyGuardedB(0.655827, 0.450792, 19, 48, 33), [52, 29]);
    assert.deepEqual(applyGuardedB(0.5, 0.5, 26, 37, 37), [37, 37]);
    // Невалидный сигнал → точный baseline normalizeTo100 без изменений.
    assert.deepEqual(applyGuardedB(0.9, 0.1, 10, 77, 13), [77, 13]);
  });

  test('D72-8: trace разделяет preCalibration и final; final = calibration(preCalibration)', () => {
    const parsed = parseVDP(buildFullVdp());
    const computed = calculateProbabilitiesWithTrace(parsed);
    const pre = computed.trace.normalized.preCalibration;
    const fin = computed.trace.normalized.final;
    // preCalibration — результат Guarded B ДО калибровки (для buildFullVdp это 52/19/29).
    assert.deepEqual(pre, { team1: 52, draw: 19, team2: 29 });
    assert.deepEqual(fin, { team1: 59, draw: 15, team2: 26 });
    // final обязан равняться применяемой калибровке к preCalibration.
    assert.deepEqual(applyTemperatureScaling(pre.team1, pre.draw, pre.team2), [fin.team1, fin.draw, fin.team2]);
    assert.equal(computed.trace.normalized.temperature, CALIBRATION_TEMPERATURE);
    // draw Guarded B (19) отличается от финального (15) — значит калибровка — отдельный шаг.
    assert.notEqual(pre.draw, fin.draw);
    assert.notDeepEqual(pre, fin);
  });

  test('D72-9: public output === normalized.final (никакого пост-калибровочного шага)', () => {
    for (const raw of [buildFullVdp(), buildEmptyFormsVdp(), buildIncompleteVdp(1, 1), '']) {
      const computed = calculateProbabilitiesWithTrace(parseVDP(raw));
      assert.deepEqual(computed.result, computed.trace.normalized.final);
    }
  });

  test('D72-10: base draw-formula trace (draw.drawPct) не затронута калибровкой', () => {
    const parsed = parseVDP(buildEmptyFormsVdp());
    const t = buildEngineTrace(parsed);
    // drawPct остаётся базовым компонентом draw (8..45), а не финальным draw %.
    assert.equal(t.draw.drawPct, 34);
    assert.ok(t.draw.drawPct >= 8 && t.draw.drawPct <= 45);
    assert.deepEqual(t.normalized.preCalibration, { team1: 37, draw: 26, team2: 37 });
    assert.deepEqual(t.normalized.final, { team1: 38, draw: 24, team2: 38 });
  });
});

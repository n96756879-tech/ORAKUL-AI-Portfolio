// P0-регрессионные тесты Probability Engine (Tests 7–10) — текущее поведение.
// Известные спорные места (fallback 37/26/37, поведение draw, substring-H2H)
// сознательно фиксируются КАК ЕСТЬ.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateProbabilities, formScore } from '../src/lib/probability-engine';
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
    assert.deepEqual(rEmpty, { team1: 37, draw: 26, team2: 37 });

    // Имена есть, матчей нет — тот же fallback
    const rNamesOnly = calculateProbabilities(parseVDP(buildEmptyFormsVdp()));
    assert.deepEqual(rNamesOnly, { team1: 37, draw: 26, team2: 37 });

    // Минимальный: по одному матчу — НЕ fallback (фиксируем факт)
    const rOne = calculateProbabilities(parseVDP(buildIncompleteVdp(1, 1)));
    assert.notDeepEqual(rOne, { team1: 37, draw: 26, team2: 37 });
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

  test('R3: Netherlands–Germany fixture — формы 8/12 и 7/12 и Engine 39/22/39', () => {
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
    assert.deepEqual(r, { team1: 39, draw: 22, team2: 39 });
  });

  test('R4: fixture без UNKNOWN сохраняет прежний результат', () => {
    const parsed = parseVDP(buildFullVdp());
    // Регрессия: без UNKNOWN знаменатель не меняется, поэтому вывод прежний.
    assert.equal(formScore(parsed.team1), 10 / 15);
    assert.equal(formScore(parsed.team2), 7 / 15);
    const r = calculateProbabilities(parsed);
    assert.deepEqual(r, { team1: 48, draw: 19, team2: 33 });
  });
});

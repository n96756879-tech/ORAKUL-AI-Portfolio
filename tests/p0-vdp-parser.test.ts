// P0-регрессионные тесты VDP Parser (Tests 1–6).
// Фиксируют ТЕКУЩЕЕ поведение parseVDP; известные спорные места сознательно
// зафиксированы как есть (не чинятся).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVDP } from '../src/lib/vdp-parser';
import {
  buildFullVdp,
  buildFactOnlyVdp,
  vdpWithH2HBullet,
  vdpWithH2HMatchBlocks,
  buildMissingFieldsVdp,
  buildEmptyFormsVdp,
  buildIncompleteVdp,
} from './helpers/fixtures';

describe('P0 VDP Parser (current behavior)', () => {
  let fullParsed: ReturnType<typeof parseVDP>;

  before(() => {
    fullParsed = parseVDP(buildFullVdp());
  });

  test('T1: full VDP — team names, 5+5 matches, H2H parsed', () => {
    assert.equal(fullParsed.team1.teamName, 'Team A');
    assert.equal(fullParsed.team2.teamName, 'Team B');
    assert.equal(fullParsed.team1.matches.length, 5);
    assert.equal(fullParsed.team2.matches.length, 5);
    assert.equal(fullParsed.h2h.length, 1);
    // Поле MATCH 1 team1
    const m1 = fullParsed.team1.matches[0];
    assert.equal(m1.date, '2026-09-20');
    assert.equal(m1.opponent, 'Team X');
    assert.equal(m1.venue, 'HOME');
    assert.equal(m1.score, '2-1');
    assert.equal(m1.goalsFor, 2);
    assert.equal(m1.goalsAgainst, 1);
    assert.equal(m1.result, 'W');
  });

  test('T1b: full VDP - markdown headers are consumed for both teams', () => {
    // Формат `## TEAM 1 FORM` / `## TEAM 2 FORM` даёт 5+5 матчей
    const incomplete = parseVDP(buildIncompleteVdp(5, 5));
    assert.equal(incomplete.team1.matches.length, 5);
    assert.equal(incomplete.team2.matches.length, 5);
  });

  test('T2: FACT-only identification - names from "- **FACT:** A vs B"', () => {
    const parsed = parseVDP(buildFactOnlyVdp());
    assert.equal(parsed.team1.teamName, 'Team Alpha');
    assert.equal(parsed.team2.teamName, 'Team Beta');
    assert.equal(parsed.team1.matches.length, 5);
    assert.equal(parsed.team2.matches.length, 5);
  });

  test('T3: H2H bullet FACT format — "- **FACT:** Team A 2-1 Team B" blocks in ## H2H', () => {
    const parsed = parseVDP(vdpWithH2HBullet());
    assert.equal(parsed.h2h.length, 2);
    const first = parsed.h2h[0];
    assert.equal(first.date, '14.11.2024.');
    assert.equal(first.score, '2-1.');
    assert.equal(first.winner, 'Team A.');
    assert.equal(first.status, 'CONFIRMED.');
  });

  test('T4: H2H ### H2H n blocks after ## HEAD-TO-HEAD parsed', () => {
    const parsed = parseVDP(vdpWithH2HMatchBlocks());
    assert.equal(parsed.h2h.length, 2);
    const first = parsed.h2h[0];
    assert.equal(first.date, '14.11.2024.');
    assert.equal(first.competition, 'Cup.');
    assert.equal(first.score, 'Team A 2-1 Team B.');
    assert.equal(first.winner, 'Team A.');
    assert.equal(first.status, 'CONFIRMED.');
  });

  test('T5: missing fields — no crash, result defaults to UNKNOWN', () => {
    const parsed = parseVDP(buildMissingFieldsVdp());
    assert.equal(parsed.team1.matches.length, 5);
    const [m1, m2, m3, m4, m5] = parsed.team1.matches;

    assert.equal(m1.result, 'W');
    // MATCH 2: RESULT отсутствует -> UNKNOWN
    assert.equal(m2.result, 'UNKNOWN');
    assert.equal(m2.score, '1-1');
    // MATCH 4: SCORE отсутствует -> null, result 'L'
    assert.equal(m4.score, null);
    assert.equal(m4.goalsFor, null);
    assert.equal(m4.goalsAgainst, null);
    assert.equal(m4.result, 'L');
    // MATCH 5: RESULT: MAYBE — неизвестное значение -> UNKNOWN, без crash
    assert.equal(m5.score, '2-0');
    assert.equal(m5.result, 'UNKNOWN');
  });

  test('T6: incomplete VDP — 0/1/4/5 matches without crash', () => {
    for (const [c1, c2] of [[0, 0], [1, 1], [4, 4], [5, 5]] as const) {
      const parsed = parseVDP(buildIncompleteVdp(c1, c2));
      assert.equal(parsed.team1.matches.length, c1);
      assert.equal(parsed.team2.matches.length, c2);
      assert.equal(parsed.team1.teamName, 'Team A');
      assert.equal(parsed.team2.teamName, 'Team B');
    }
    // Пустые формы: имена из FACT, 0 матчей
    const emptyForms = parseVDP(buildEmptyFormsVdp());
    assert.equal(emptyForms.team1.teamName, 'Team A');
    assert.equal(emptyForms.team2.teamName, 'Team B');
    assert.equal(emptyForms.team1.matches.length, 0);
    assert.equal(emptyForms.team2.matches.length, 0);
  });

  test('T6b: real VDP fixture — italy-belgium (H2H n blocks)', () => {
    const raw = readFileSync(join(process.cwd(), 'italy-belgium-vdp.txt'), 'utf8');
    const parsed = parseVDP(raw);
    // Фиксируем текущее поведение: имена извлекаются в ВЕРХНЕМ регистре из FACT/MATCH-заголовка
    assert.equal(parsed.team1.teamName, 'ITALY');
    assert.equal(parsed.team2.teamName, 'BELGIUM');
    assert.equal(parsed.team1.matches.length, 5);
    assert.equal(parsed.team2.matches.length, 5);
    assert.ok(Array.isArray(parsed.h2h));
  });
});


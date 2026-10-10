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

const oldArmeniaMontenegroVdp = `# VERIFIED DATA PACK

## TEAM 1 - RECENT FORM: ARMENIA
### MATCH 1
- **DATE:** 25.09.2026
- **OPPONENT:** Latvia
- **HOME/AWAY:** Home
- **SCORE:** Armenia 2–0 Latvia
- **RESULT:** W
### MATCH 2
- **DATE:** 16.11.2025
- **OPPONENT:** Portugal
- **HOME/AWAY:** Away
- **SCORE:** Portugal 9–1 Armenia
- **RESULT:** L
### MATCH 3
- **DATE:** 14.11.2025
- **OPPONENT:** Hungary
- **HOME/AWAY:** Home
- **SCORE:** Armenia 0–1 Hungary
- **RESULT:** L
### MATCH 4
- **DATE:** 11.10.2025
- **OPPONENT:** Ireland
- **HOME/AWAY:** Away
- **SCORE:** Ireland 1–0 Armenia
- **RESULT:** L
### MATCH 5
- **DATE:** 09.09.2025
- **OPPONENT:** Portugal
- **HOME/AWAY:** Home
- **SCORE:** Armenia 0–5 Portugal
- **RESULT:** L

## TEAM 2 - RECENT FORM: MONTENEGRO
### MATCH 1
- **DATE:** 25.09.2026
- **OPPONENT:** Gibraltar
- **HOME/AWAY:** Away
- **SCORE:** Gibraltar 0–1 Montenegro
- **RESULT:** W
### MATCH 2
- **DATE:** 17.11.2025
- **OPPONENT:** Croatia
- **HOME/AWAY:** Away
- **SCORE:** Croatia 4–0 Montenegro
- **RESULT:** L
### MATCH 3
- **DATE:** 14.11.2025
- **OPPONENT:** Iceland
- **HOME/AWAY:** Home
- **SCORE:** Montenegro 2–0 Iceland
- **RESULT:** W
### MATCH 4
- **DATE:** 09.10.2025
- **OPPONENT:** Czechia
- **HOME/AWAY:** Away
- **SCORE:** Czechia 2–0 Montenegro
- **RESULT:** L
### MATCH 5
- **DATE:** 06.09.2025
- **OPPONENT:** Faroe Islands
- **HOME/AWAY:** Away
- **SCORE:** Faroe Islands 4–0 Montenegro
- **RESULT:** L

## H2H
### H2H 1
- **DATE:** 06.06.2025
- **SCORE:** 2-2
- **WINNER:** Draw
`;

const newArmeniaMontenegroVdp = `# VERIFIED DATA PACK

## MATCH VERIFICATION
- **FACT:** Armenia vs Montenegro, UEFA Nations League 2026/27

## TEAM 1 — RECENT FORM: ARMENIA
### MATCH 1
- **DATE:** 25.09.2026
- **COMPETITION:** UEFA Nations League
- **OPPONENT:** Latvia
- **HOME/AWAY:** Home
- **SCORE:** Armenia 2–0 Latvia
- **RESULT:** W
- **OPPONENT_STRENGTH:** UNKNOWN
### MATCH 2
- **DATE:** 16.11.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Portugal
- **HOME/AWAY:** Away
- **SCORE:** Portugal 9–1 Armenia
- **RESULT:** L
### MATCH 3
- **DATE:** 14.11.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Hungary
- **HOME/AWAY:** Home
- **SCORE:** Armenia 0–1 Hungary
- **RESULT:** L
### MATCH 4
- **DATE:** 11.10.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Ireland
- **HOME/AWAY:** Away
- **SCORE:** Ireland 1–0 Armenia
- **RESULT:** L
### MATCH 5
- **DATE:** 09.09.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Portugal
- **HOME/AWAY:** Home
- **SCORE:** Armenia 0–5 Portugal
- **RESULT:** L

## TEAM 2 — RECENT FORM: MONTENEGRO
### MATCH 1
- **DATE:** 25.09.2026
- **COMPETITION:** UEFA Nations League
- **OPPONENT:** Gibraltar
- **HOME/AWAY:** Away
- **SCORE:** Gibraltar 0–1 Montenegro
- **RESULT:** W
- **OPPONENT_STRENGTH:** UNKNOWN
### MATCH 2
- **DATE:** 17.11.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Croatia
- **HOME/AWAY:** Away
- **SCORE:** Croatia 4–0 Montenegro
- **RESULT:** L
### MATCH 3
- **DATE:** 14.11.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Iceland
- **HOME/AWAY:** Home
- **SCORE:** Montenegro 2–0 Iceland
- **RESULT:** W
### MATCH 4
- **DATE:** 09.10.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Czechia
- **HOME/AWAY:** Away
- **SCORE:** Czechia 2–0 Montenegro
- **RESULT:** L
### MATCH 5
- **DATE:** 06.09.2025
- **COMPETITION:** World Cup Qualifiers
- **OPPONENT:** Faroe Islands
- **HOME/AWAY:** Away
- **SCORE:** Faroe Islands 4–0 Montenegro
- **RESULT:** L

## H2H
### H2H 1
- **DATE:** 06.06.2025
- **SCORE:** 2–2
- **WINNER:** Draw
### H2H 2
- **DATE:** 12.11.2020
- **SCORE:** 0–0
- **WINNER:** Draw
`;

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
    const [m1, m2, , m4, m5] = parsed.team1.matches;

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

  test('T7: Armenia-Montenegro OLD and NEW Research VDP formats', () => {
    for (const raw of [oldArmeniaMontenegroVdp, newArmeniaMontenegroVdp]) {
      const parsed = parseVDP(raw);
      assert.equal(parsed.team1.teamName, 'ARMENIA');
      assert.equal(parsed.team2.teamName, 'MONTENEGRO');
      assert.equal(parsed.team1.matches.length, 5);
      assert.equal(parsed.team2.matches.length, 5);
      assert.equal(parsed.team1.matches[0].result, 'W');
      assert.notEqual(parsed.team1.matches[0].goalsFor, null);
      assert.notEqual(parsed.team1.matches[0].goalsAgainst, null);
      assert.equal(parsed.team2.matches[0].result, 'W');
      assert.notEqual(parsed.team2.matches[0].goalsFor, null);
      assert.notEqual(parsed.team2.matches[0].goalsAgainst, null);
      assert.ok(parsed.h2h.length > 0);
    }
  });

  test('T8: concrete draw normalizes No winner to DRAW', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## HEAD-TO-HEAD
### H2H 1
- **DATE:** 09.06.2025
- **TOURNAMENT:** International friendly
- **SCORE:** Montenegro 2-2 Armenia
- **WINNER:** No winner
`);

    assert.equal(parsed.h2h.length, 1);
    assert.equal(parsed.h2h[0].winner, 'DRAW');
  });

  test('T9: aggregate H2H summary is not a match', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## H2H
- **FACT:** Armenia 2 wins, Montenegro 1 win, Draw 1
- **DATE:** Aggregate period
- **SOURCE:** FootyStats
- **STATUS:** PARTIALLY_CONFIRMED
`);

    assert.equal(parsed.h2h.length, 0);
  });

  test('T10: different meetings with the same score are retained', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## H2H
- **FACT:** Montenegro 2-2 Armenia
- **DATE:** 09.06.2025
- **SCORE:** Montenegro 2-2 Armenia
- **WINNER:** Draw
- **STATUS:** CONFIRMED
- **FACT:** Montenegro 2-2 Armenia
- **DATE:** 10.06.2017
- **SCORE:** Montenegro 2-2 Armenia
- **WINNER:** DRAW
- **STATUS:** CONFIRMED
`);

    assert.equal(parsed.h2h.length, 2);
    assert.deepEqual(parsed.h2h.map((entry) => entry.date), ['09.06.2025', '10.06.2017']);
  });

  test('T11: free-form H2H keeps only concrete Turkey/Türkiye-Italy meetings', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Türkiye–Italy, UEFA Nations League

## HEAD-TO-HEAD
20.09.2026 — Türkiye 2–1 Italy
20 Sep 2025 — Türkiye 2-1 Italy
2024-09-20: Türkiye 2-1 Italy
Türkiye 2-1 Italy
Italy 0-0 Türkiye
Italy 4-0 Spain
Türkiye and Italy have met 12 times
`);

    assert.equal(parsed.h2h.length, 4);
    assert.deepEqual(parsed.h2h.map((entry) => entry.date), [
      '20 Sep 2025',
      '2024-09-20',
      null,
      null,
    ]);
    assert.deepEqual(parsed.h2h.map((entry) => entry.winner), ['Türkiye', 'Türkiye', 'Türkiye', 'DRAW']);
  });

  test('T12: H2H requires both a supported date and score, and exact duplicates are removed', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Turkey vs Italy

## H2H
2026-09-20: Turkey 2-1 Italy
2026-09-20: Turkey 2-1 Italy
Turkey 1-1 Italy
Turkey beat Italy
`);

    assert.equal(parsed.h2h.length, 2);
    assert.equal(parsed.h2h[0].winner, 'Turkey');
    assert.equal(parsed.h2h[1].winner, 'DRAW');
  });

  test('T13: aggregate H2H FACT parses concrete meetings with null date/competition', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Barcelona vs Real Madrid

## H2H
- **FACT:** Barcelona 4–3 Real Madrid; Barcelona 3–2 Real Madrid aet; Real Madrid 2–5 Barcelona; Real Madrid 0–4 Barcelona; Real Madrid 3–2 Barcelona; Real Madrid 4–1 Barcelona.
- **DATE:** 14.01.2024–11.05.2025
- **TOURNAMENT:** LaLiga, Copa del Rey, Supercopa de España
- **STATUS:** PARTIALLY_CONFIRMED
`);

    assert.equal(parsed.h2h.length, 6);
    assert.deepEqual(parsed.h2h.map((e) => e.score), ['4-3', '3-2', '2-5', '0-4', '3-2', '4-1']);
    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['Barcelona', 'Barcelona', 'Barcelona', 'Barcelona', 'Real Madrid', 'Real Madrid']);
    assert.ok(parsed.h2h.every((e) => e.date === null));
    assert.ok(parsed.h2h.every((e) => e.competition === null));
  });

  test('T14: aggregate H2H FACT draw -> winner DRAW', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Team A vs Team B

## H2H
- **FACT:** Team A 2–2 Team B
`);

    assert.equal(parsed.h2h.length, 1);
    assert.equal(parsed.h2h[0].score, '2-2');
    assert.equal(parsed.h2h[0].winner, 'DRAW');
    assert.equal(parsed.h2h[0].date, null);
  });

  test('T15: aggregate FACT outside H2H section is not parsed', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Barcelona vs Real Madrid

## FORM SUMMARY
- **FACT:** Barcelona 3–1 Real Madrid; Barcelona 2–0 Real Madrid
`);

    assert.equal(parsed.h2h.length, 0);
  });

  test('T16: numbered H2H — English Winner: and score fallback', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** France vs Spain

## HEAD-TO-HEAD
1. **14.10.2024 — Friendly:** France 1–0 Spain. **Winner:** France.
2. **10.09.2024 — Friendly:** France 2–2 Spain. **Winner:** draw.
3. **26.03.2024 — Friendly:** Spain 2–1 France. **Winner:** Spain.
4. **06.09.2019 — Friendly:** France 0–3 Spain.
`);

    assert.equal(parsed.h2h.length, 4);
    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['FRANCE', 'DRAW', 'SPAIN', 'SPAIN']);
  });

  test('T17: numbered H2H — Russian победитель inline (not score fallback)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Франция vs Испания

## HEAD-TO-HEAD
1. **14.10.2024 — Товарищеский:** Франция 1–2 Испания. победитель: Франция.
`);

    assert.equal(parsed.h2h.length, 1);
    assert.equal(parsed.h2h[0].winner, 'ФРАНЦИЯ');
  });

  test('T18: ### H2H n — unequal SCORE без WINNER -> winner из score', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** France vs Spain

## H2H
### H2H 1
- **DATE:** 14.11.2024
- **TOURNAMENT:** Cup
- **SCORE:** 1-0
`);

    assert.equal(parsed.h2h.length, 1);
    assert.equal(parsed.h2h[0].winner, 'FRANCE');
    assert.equal(parsed.h2h[0].date, '14.11.2024');
    assert.equal(parsed.h2h[0].competition, 'Cup');
  });

  test('T19: bullet H2H — unequal SCORE без WINNER -> winner из score', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** France vs Spain

## H2H
- **FACT:** France 0-3 Spain
- **DATE:** 10.10.2024
- **SCORE:** 0-3
`);

    assert.equal(parsed.h2h.length, 1);
    assert.equal(parsed.h2h[0].winner, 'SPAIN');
    assert.equal(parsed.h2h[0].date, '10.10.2024');
  });

  test('T20: D-14 mixed-script winner canonicalized via corroborated MATCH home/away bridge', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Netherlands vs Germany, UEFA Nations League; Netherlands home, Germany away.

# TEAM 1 — RECENT FORM: НИДЕРЛАНДЫ
### MATCH 1
- **SCORE:** 2-0

# TEAM 2 — RECENT FORM: ГЕРМАНИЯ
### MATCH 1
- **SCORE:** 0-2

## H2H
1. **14.10.2024 — Friendly:** Germany 1–0 Netherlands. **Winner:** Germany.
2. **10.09.2024 — Friendly:** Netherlands 0–0 Germany. **Winner:** draw.
3. **26.03.2024 — Friendly:** Netherlands 2–1 Germany. **Winner:** Netherlands.
`);

    assert.equal(parsed.team1.teamName, 'НИДЕРЛАНДЫ');
    assert.equal(parsed.team2.teamName, 'ГЕРМАНИЯ');
    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['ГЕРМАНИЯ', 'DRAW', 'НИДЕРЛАНДЫ']);
  });

  test('T21: D-14 no canonicalization without corroborating home/away clause', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Netherlands vs Germany, UEFA Nations League.

# TEAM 1 — RECENT FORM: НИДЕРЛАНДЫ
### MATCH 1
- **SCORE:** 2-0

# TEAM 2 — RECENT FORM: ГЕРМАНИЯ
### MATCH 1
- **SCORE:** 0-2

## H2H
1. **14.10.2024 — Friendly:** Germany 1–0 Netherlands. **Winner:** Germany.
`);

    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['GERMANY']);
  });

  test('T22: D-14 no canonicalization when home/away disagrees with vs-order', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Netherlands vs Germany, UEFA Nations League; Germany home, Netherlands away.

# TEAM 1 — RECENT FORM: НИДЕРЛАНДЫ
### MATCH 1
- **SCORE:** 2-0

# TEAM 2 — RECENT FORM: ГЕРМАНИЯ
### MATCH 1
- **SCORE:** 0-2

## H2H
1. **14.10.2024 — Friendly:** Germany 1–0 Netherlands. **Winner:** Germany.
`);

    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['GERMANY']);
  });

  test('T23: summary FACT is not a team name — identity from MATCH bridge', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Wales vs Denmark, 04.10.2026, 19:45 BST, UEFA Nations League 2026/27, League A Group A4, Matchday 4, Cardiff City Stadium; Wales home, Denmark away.

## TEAM 1 FORM
- **FACT:** Wales last five official matches: W-L-L-D-W; 2 wins, 1 draw, 2 losses; GF 10, GA 6, GD +4.

## TEAM 2 FORM
- **FACT:** Denmark last five official matches: L-W-L-D-W; 2 wins, 1 draw, 2 losses; GF 12, GA 9, GD +3.
`);

    assert.equal(parsed.team1.teamName, 'Wales');
    assert.equal(parsed.team2.teamName, 'Denmark');
    assert.ok(!/FACT:/i.test(parsed.team1.teamName!));
    assert.ok(!/FACT:/i.test(parsed.team2.teamName!));
    assert.ok(!/last four|last five|official matches/i.test(parsed.team1.teamName!));
    assert.ok(!/last four|last five|official matches/i.test(parsed.team2.teamName!));
  });

  test('T24: aggregate H2H with trailing date parenthetical parses all meetings', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Wales vs Denmark; Wales home, Denmark away.

## H2H
- **FACT:** Wales 0-1 Denmark (OCT 2023)
- **FACT:** Wales 1-3 Denmark (JUN 2022)
- **FACT:** Denmark 2-0 Wales (SEP 2021)
- **FACT:** Wales 2-2 Denmark (NOV 2020)
`);

    assert.equal(parsed.h2h.length, 4);
    assert.deepEqual(parsed.h2h.map((e) => e.score), ['0-1', '1-3', '2-0', '2-2']);
    assert.deepEqual(parsed.h2h.map((e) => e.winner), ['Denmark', 'Denmark', 'Denmark', 'DRAW']);
  });

  test('T25: D-23 summary-FACT identity recovered from MATCH section WITHOUT H2H', () => {
    // Ireland–Israel production shape: H2H отсутствует, но в MATCH есть однозначная пара.
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Ireland vs Israel, UEFA Nations League, 04.10.2026.

## TEAM 1 - RECENT FORM: FACT: Ireland last five official matches: D-W-L-D-W; 2W 2D 1L; GF10 GA7 GD+3

## TEAM 2 - RECENT FORM: FACT: Israel last five official matches: D-L-L-W-W; 2W 1D 2L; GF6 GA7 GD-1
`);

    assert.equal(parsed.team1.teamName, 'Ireland');
    assert.equal(parsed.team2.teamName, 'Israel');
    assert.ok(!/FACT:/i.test(parsed.team1.teamName!));
    assert.ok(!/FACT:/i.test(parsed.team2.teamName!));
    assert.ok(!/last five|official matches/i.test(parsed.team1.teamName!));
    assert.ok(!/last five|official matches/i.test(parsed.team2.teamName!));
  });

  test('T26: D-23 summary-FACT with no recoverable identity -> null, not summary FACT', () => {
    // MATCH FACT не содержит однозначного "A vs B" → имя не придумываем.
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** kickoff at 18:45 UTC.

## TEAM 1 - RECENT FORM: FACT: Ireland last five official matches: D-W-L-D-W; GF10 GA7 GD+3

## TEAM 2 - RECENT FORM: FACT: Israel last five official matches: D-L-L-W-W; GF6 GA7 GD-1
`);

    assert.equal(parsed.team1.teamName, null);
    assert.equal(parsed.team2.teamName, null);
    assert.ok(!/FACT:/i.test(String(parsed.team1.teamName)));
    assert.ok(!/FACT:/i.test(String(parsed.team2.teamName)));
  });

  test('T27 (A): currentVenue HOME when team1 is home', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026; Alpha home, Beta away.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.team1.teamName, 'Alpha');
    assert.equal(parsed.team2.teamName, 'Beta');
    assert.equal(parsed.currentVenue, 'HOME');
  });

  test('T28 (A): cross-script names — positional vs-order still yields HOME', () => {
    // Реальный кейс Netherlands–Germany: шапка на кириллице, MATCH FACT на латинице.
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Netherlands vs Germany, 24.09.2026, 20:45, League A; Netherlands home, Germany away.

## TEAM 1 - RECENT FORM: НИДЕРЛАНДЫ
- **FACT:** form

## TEAM 2 - RECENT FORM: ГЕРМАНИЯ
- **FACT:** form
`);
    assert.equal(parsed.team1.teamName, 'НИДЕРЛАНДЫ');
    assert.equal(parsed.team2.teamName, 'ГЕРМАНИЯ');
    assert.equal(parsed.currentVenue, 'HOME');
  });

  test('T29 (B): currentVenue AWAY when team1 is away (reversed fixture)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026; Beta home, Alpha away.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'AWAY');
  });

  test('T30 (C): explicit neutral venue -> NEUTRAL', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026; neutral venue.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'NEUTRAL');
  });

  test('T31 (D): no venue clause -> UNKNOWN (no guessing)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  test('T32 (D): currentVenue does not fall back to MATCH 1 historical venue', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026.

## TEAM 1 FORM
- **FACT:** Alpha

### MATCH 1
- **DATE:** 2026-09-20
- **OPPONENT:** O
- **HOME/AWAY:** HOME
- **SCORE:** 3-0
- **RESULT:** W

## TEAM 2 FORM
- **FACT:** Beta

### MATCH 1
- **DATE:** 2026-09-19
- **OPPONENT:** O
- **HOME/AWAY:** AWAY
- **SCORE:** 0-3
- **RESULT:** L
`);
    assert.equal(parsed.team1.matches[0]?.venue, 'HOME');
    assert.equal(parsed.team2.matches[0]?.venue, 'AWAY');
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  // D-68: Russian venue markers inside ## MATCH FACT lines.
  test('D-68 T33: Russian HOME clause -> HOME', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Крылья Советов vs Спартак Москва, РПЛ; Крылья Советов дома, Спартак Москва в гостях.

## TEAM 1 - RECENT FORM: КРЫЛЬЯ СОВЕТОВ
- **FACT:** form

## TEAM 2 - RECENT FORM: СПАРТАК МОСКВА
- **FACT:** form
`);
    assert.equal(parsed.team1.teamName, 'КРЫЛЬЯ СОВЕТОВ');
    assert.equal(parsed.team2.teamName, 'СПАРТАК МОСКВА');
    assert.equal(parsed.currentVenue, 'HOME');
  });

  test('D-68 T34: Russian AWAY clause -> AWAY (reversed fixture)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League; Beta дома, Alpha в гостях.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'AWAY');
  });

  test('D-68 T35: Russian neutral clause -> NEUTRAL', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League; нейтральное поле.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'NEUTRAL');
  });

  test('D-68 T36: Russian capitalization / case variants handled', () => {
    const homeOnOwnField = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Крылья Советов На своём поле, Спартак Москва НА ВЫЕЗДЕ.

## TEAM 1 - RECENT FORM: КРЫЛЬЯ СОВЕТОВ
- **FACT:** form

## TEAM 2 - RECENT FORM: СПАРТАК МОСКВА
- **FACT:** form
`);
    assert.equal(homeOnOwnField.currentVenue, 'HOME');

    const awayUpper = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League; Alpha В ГОСТЯХ, Beta ДОМА.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(awayUpper.currentVenue, 'AWAY');
  });

  test('D-68 T37: English markers still parsed alongside Russian support', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026; Alpha home, Beta away.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'HOME');
  });

  test('D-68 T38: no venue statement -> UNKNOWN (Russian teams, no guessing)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Крылья Советов vs Спартак Москва, РПЛ, 04.10.2026.

## TEAM 1 - RECENT FORM: КРЫЛЬЯ СОВЕТОВ
- **FACT:** form

## TEAM 2 - RECENT FORM: СПАРТАК МОСКВА
- **FACT:** form
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  test('D-68 T39: team order alone does not infer venue', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  test('D-68 T40: Russian venue wording outside ## MATCH is not accepted', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026.

## TEAM 1 FORM
- **FACT:** Alpha дома

## TEAM 2 FORM
- **FACT:** Beta в гостях
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  test('D-68 T41: Russian venue wording on a non-FACT line inside ## MATCH is not accepted', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Alpha vs Beta, League, 04.10.2026.
- Note: Alpha дома, Beta в гостях.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });

  test('D-68 T42: Russian clause with unmatched team names -> UNKNOWN (no guessing)', () => {
    const parsed = parseVDP(`# VERIFIED DATA PACK

## MATCH
- **FACT:** Gamma дома, Delta в гостях.

## TEAM 1 FORM
- **FACT:** Alpha

## TEAM 2 FORM
- **FACT:** Beta
`);
    assert.equal(parsed.currentVenue, 'UNKNOWN');
  });
});

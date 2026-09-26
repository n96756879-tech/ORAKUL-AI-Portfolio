import fs from 'fs';
import { parseVDP, type ParsedVDP } from '../src/lib/vdp-parser';

type Check = { name: string; parsed: ParsedVDP; expect: (p: ParsedVDP) => boolean; failMsg: (p: ParsedVDP) => string };

function runCheck(c: Check): boolean {
  const ok = c.expect(c.parsed);
  if (!ok) {
    console.error('FAIL:', c.name);
    console.error('  ', c.failMsg(c.parsed));
  } else {
    console.log('PASS:', c.name);
  }
  return ok;
}

function main() {
  const results: boolean[] = [];

  // 1. Full saved VDP (pre + final VDP block) — must have names + 5+5 + h2h from HEAD-TO-HEAD numbered subs
  const italyFull = fs.readFileSync('italy-belgium-vdp.txt', 'utf8');
  const idxIt = italyFull.indexOf('VERIFIED DATA PACK');
  const vdpIt = idxIt >= 0 ? italyFull.slice(idxIt) : italyFull;
  const pIt = parseVDP(vdpIt);
  results.push(runCheck({
    name: 'italy-full (real file): names + 5+5 + h2h>=2',
    parsed: pIt,
    expect: p => !!p.team1.teamName && !!p.team2.teamName && p.team1.matches.length >= 5 && p.team2.matches.length >= 5 && p.h2h.length >= 2,
    failMsg: p => `names=${p.team1.teamName}/${p.team2.teamName} matches=${p.team1.matches.length}/${p.team2.matches.length} h2h=${p.h2h.length}`
  }));

  // 2. Other real sample
  const realFull = fs.readFileSync('real-vdp-sample.txt', 'utf8');
  const idxR = realFull.indexOf('VERIFIED DATA PACK');
  const vdpR = idxR >= 0 ? realFull.slice(idxR) : realFull;
  const pR = parseVDP(vdpR);
  results.push(runCheck({
    name: 'real-sample: names + 5+5 + h2h>=1',
    parsed: pR,
    expect: p => !!p.team1.teamName && !!p.team2.teamName && p.team1.matches.length >= 5 && p.team2.matches.length >= 5 && p.h2h.length >= 1,
    failMsg: p => `names=${p.team1.teamName}/${p.team2.teamName} matches=${p.team1.matches.length}/${p.team2.matches.length} h2h=${p.h2h.length}`
  }));

  // 3. England minimal as seen in prod logs (only MATCH FACT, no TEAM sections, no H2H)
  const englandMinimal = `VERIFIED DATA PACK

## MATCH

- **FACT:** England vs Spain, UEFA Nations League 2026/27, League A Group A3, Matchday 1; Wembley Stadium; England home, Spain away; 26.09.2026, 19:45 BST.
- **DATE:** 26.09.2026
- **SOURCE:** UEFA
`;
  const pEn = parseVDP(englandMinimal);
  results.push(runCheck({
    name: 'england-minimal (FACT only): fallback names from FACT, 0 matches, 0 h2h',
    parsed: pEn,
    expect: p => (p.team1.teamName === 'England' || p.team1.teamName === 'England vs Spain') && (p.team2.teamName === 'Spain' || p.team2.teamName === 'England vs Spain') && p.team1.matches.length === 0 && p.team2.matches.length === 0 && p.h2h.length === 0,
    failMsg: p => `team1Name=${p.team1.teamName} team2Name=${p.team2.teamName} m1=${p.team1.matches.length} m2=${p.team2.matches.length} h2h=${p.h2h.length}`
  }));

  // 4. Compact VDP (the actual emitted final block) with bullet H2H — must get names + 5+5 + h2h>=2 from the ## H2H bullets
  const compactItaly = `VERIFIED DATA PACK

## MATCH

- **FACT:** Italy vs Belgium; 25.09.2026, 20:45 CEST; UEFA Nations League 2026/27, League A, Group A1, Matchday 1; Stadio Olimpico, Rome; Italy home, Belgium away.
- **DATE:** 25.09.2026.
- **SOURCE:** UEFA; FIGC.

## TEAM 1 FORM — ITALY

- **FACT:** 5 confirmed official matches; W3-D1-L1; GF 9, GA 5, GD +4; sequence D-W-L-W-W.

### MATCH 1
- **DATE:** 31.03.2026.
- **COMPETITION:** FIFA World Cup qualifying play-off.
- **OPPONENT:** Bosnia and Herzegovina.
- **HOME/AWAY:** Away.
- **SCORE:** 1–1 aet; shootout lost 1–4.
- **RESULT:** D.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 2
- **DATE:** 26.03.2026.
- **COMPETITION:** FIFA World Cup qualifying play-off.
- **OPPONENT:** Northern Ireland.
- **HOME/AWAY:** Home.
- **SCORE:** 2–0.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 3
- **DATE:** 16.11.2025.
- **COMPETITION:** FIFA World Cup qualifying play-off.
- **OPPONENT:** Norway.
- **HOME/AWAY:** Away.
- **SCORE:** 3–1.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 4
- **DATE:** 13.11.2025.
- **COMPETITION:** FIFA World Cup qualifying play-off.
- **OPPONENT:** Turkey.
- **HOME/AWAY:** Home.
- **SCORE:** 5–0.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 5
- **DATE:** 14.10.2025.
- **COMPETITION:** FIFA World Cup qualifying play-off.
- **OPPONENT:** Estonia.
- **HOME/AWAY:** Away.
- **SCORE:** 0–0.
- **RESULT:** D.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

## TEAM 2 FORM — BELGIUM

- **FACT:** 5 confirmed official matches; W3-D1-L1; GF 13, GA 6, GD +7; sequence L-W-W-W-D.

### MATCH 1
- **DATE:** 10.07.2026.
- **COMPETITION:** FIFA World Cup.
- **OPPONENT:** France.
- **HOME/AWAY:** Neutral.
- **SCORE:** 0–2.
- **RESULT:** L.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 2
- **DATE:** 06.07.2026.
- **COMPETITION:** FIFA World Cup.
- **OPPONENT:** Portugal.
- **HOME/AWAY:** Neutral.
- **SCORE:** 1–0.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 3
- **DATE:** 01.07.2026.
- **COMPETITION:** FIFA World Cup.
- **OPPONENT:** Croatia.
- **HOME/AWAY:** Neutral.
- **SCORE:** 4–1.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 4
- **DATE:** 26.06.2026.
- **COMPETITION:** FIFA World Cup.
- **OPPONENT:** Ukraine.
- **HOME/AWAY:** Neutral.
- **SCORE:** 3–2.
- **RESULT:** W.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

### MATCH 5
- **DATE:** 21.06.2026.
- **COMPETITION:** FIFA World Cup.
- **OPPONENT:** Iran.
- **HOME/AWAY:** Neutral.
- **SCORE:** 0–0.
- **RESULT:** D.
- **OPPONENT_STRENGTH:** UNKNOWN.
- **CONFIDENCE:** CONFIRMED.

## H2H

- **FACT:** Belgium 0–1 Italy.
- **DATE:** 14.11.2024.
- **TOURNAMENT:** UEFA Nations League 2024/25, League A.
- **SCORE:** 0–1.
- **WINNER:** Italy.
- **SOURCE:** UEFA.
- **STATUS:** CONFIRMED.

- **FACT:** Italy 2–2 Belgium.
- **DATE:** 10.10.2024.
- **TOURNAMENT:** UEFA Nations League 2024/25, League A.
- **SCORE:** 2–2.
- **WINNER:** Draw.
- **SOURCE:** UEFA.
- **STATUS:** CONFIRMED.
`;
  const pCompact = parseVDP(compactItaly);
  results.push(runCheck({
    name: 'compact-vdp (emitted final block with bullet H2H): names + 5+5 + h2h>=2',
    parsed: pCompact,
    expect: p => !!p.team1.teamName && !!p.team2.teamName && p.team1.matches.length >= 5 && p.team2.matches.length >= 5 && p.h2h.length >= 2,
    failMsg: p => `names=${p.team1.teamName}/${p.team2.teamName} matches=${p.team1.matches.length}/${p.team2.matches.length} h2h=${p.h2h.length}`
  }));

  const allPass = results.every(Boolean);
  if (!allPass) {
    console.error('\nSome checks failed (red from production parseVDP).');
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
}

main();

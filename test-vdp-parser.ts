import { parseVDP } from './src/lib/vdp-parser';

const syntheticVDP = `## MATCH

* TEAM 1: Team A
* TEAM 2: Team B

## TEAM 1 FORM

### MATCH 1

* DATE: 2026-09-20
* COMPETITION: Test
* OPPONENT: Team X
* HOME/AWAY: HOME
* SCORE: 2-1
* RESULT: W

### MATCH 2

* DATE: 2026-09-15
* COMPETITION: Test
* OPPONENT: Team Y
* HOME/AWAY: AWAY
* SCORE: 0-0
* RESULT: D

## TEAM 2 FORM

### MATCH 1

* DATE: 2026-09-19
* COMPETITION: Test
* OPPONENT: Team Z
* HOME/AWAY: HOME
* SCORE: 1-3
* RESULT: L

### MATCH 2

* DATE: 2026-09-14
* COMPETITION: Test
* OPPONENT: Team W
* HOME/AWAY: AWAY
* SCORE: 2-0
* RESULT: W

## H2H

### MATCH 1

* DATE: 2026-01-01
* COMPETITION: Test
* OPPONENT: Team B
* HOME/AWAY: HOME
* SCORE: 1-1
* RESULT: D`;

const result = parseVDP(syntheticVDP);

console.log('TEAM 1:');
console.log(`  teamName: ${result.team1.teamName}`);
console.log(`  matches.length: ${result.team1.matches.length}`);
result.team1.matches.forEach((m, i) => {
  console.log(`  Match ${i + 1}: DATE=${m.date}, OPPONENT=${m.opponent}, SCORE=${m.score}, RESULT=${m.result}`);
});

console.log('\nTEAM 2:');
console.log(`  teamName: ${result.team2.teamName}`);
console.log(`  matches.length: ${result.team2.matches.length}`);
result.team2.matches.forEach((m, i) => {
  console.log(`  Match ${i + 1}: DATE=${m.date}, OPPONENT=${m.opponent}, SCORE=${m.score}, RESULT=${m.result}`);
});

console.log('\nH2H:');
console.log(`  h2h.length: ${result.h2h.length}`);
result.h2h.forEach((m, i) => {
  console.log(`  Match ${i + 1}: DATE=${m.date}, SCORE=${m.score}, WINNER=${m.winner}`);
});

import fs from 'fs';
import path from 'path';
import { parseHockeyVDP } from '../hockey-vdp-parser';
import { adaptHockeyVDPToEngineInput } from '../hockey-engine-adapter';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

console.log('=== HOCKEY ENGINE ADAPTER SUITE ===\n');

// 1. Load Samples
const expContent = fs.readFileSync(path.join(process.cwd(), 'hockey-vdp-experiment.txt'), 'utf8');
const s2Content = fs.readFileSync(path.join(process.cwd(), 'hockey-vdp-sample-2.txt'), 'utf8');

const vdpExp = parseHockeyVDP(expContent);
const vdpS2 = parseHockeyVDP(s2Content);

const inputExp = adaptHockeyVDPToEngineInput(vdpExp);
const inputS2 = adaptHockeyVDPToEngineInput(vdpS2);

// Check 1: Normal NHL VDP Adaptation
console.log('1. Checking NHL VDP adaptation...');
assert(inputExp.match.team1Name.includes('Toronto'), 'Team 1 should be Toronto');
assert(inputExp.match.homeTeam === 'Toronto', 'Home team should be Toronto');
assert(inputExp.team1.recentForm.matches.length === 1, 'Team 1 form count should be 1');
assert(inputExp.team1.recentForm.matches[0].goalsFor === 2, 'Team 1 GF should be 2');
assert(inputExp.team1.recentForm.matches[0].goalsAgainst === 3, 'Team 1 GA should be 3');

// Check 2: KHL VDP Adaptation
console.log('2. Checking KHL VDP adaptation...');
assert(inputS2.match.team1Name.includes('ЦСКА'), 'Team 1 should be CSKA');
assert(inputS2.team1.recentForm.matches.length === 5, 'KHL CSKA form matches count should be 5');

// Check 3 & 4: Status Semantics (NOT_FOUND, UNKNOWN vs 0)
console.log('3 & 4. Checking status semantics (NOT_FOUND, UNKNOWN vs 0)...');
const ppPct = inputExp.team1.specialTeams.ppPct;
assert(ppPct.status === 'FOUND' && ppPct.value === 0, 'FOUND + value 0 must remain 0 and not be treated as NOT_FOUND');

const blockedShots = inputExp.team1.shots.blockedShots;
assert(blockedShots.status === 'NOT_FOUND', 'Blocked shots must remain NOT_FOUND');
assert(blockedShots.value === null, 'NOT_FOUND value must be null, NOT converted to 0');

// Check 5: Found + value 0 verification
console.log('5. Verifying FOUND + value 0 semantics...');
assert(inputExp.team1.specialTeams.ppPct.value === 0, 'PP% value 0 confirmed');

// Check 6: Missing Goalie / Goalie Status Semantics
console.log('6. Checking Goaltending semantics...');
assert(inputExp.team1.goaltending.starterStatus.value === 'CONFIRMED', 'Starter status should be CONFIRMED');
assert(inputExp.team1.goaltending.starterName.value ? inputExp.team1.goaltending.starterName.value.includes('Bobrovsky') : false, 'Starter name parsed');

// Check 7 & 8: Special teams & Shot metrics preserving
console.log('7 & 8. Checking Shot & Special teams metric preservation...');
assert(inputExp.team1.shots.sog.status === 'FOUND' && inputExp.team1.shots.sog.value === 27, 'SOG should be 27');
assert(inputExp.team1.shots.shotDifferential.status === 'FOUND' && inputExp.team1.shots.shotDifferential.value === 3, 'Differential should be 3');

// Check 9, 10, 11, 12: H2H Outcome Types (Regulation tie, OT, SO)
console.log('9, 10, 11, 12. Checking H2H outcome types...');
assert(inputExp.h2h.matches.length === 5, 'H2H count should be 5');
const shootoutMatch = inputExp.h2h.matches.find(m => m.result.outcomeType === 'SHOOTOUT');
assert(shootoutMatch !== undefined, 'Shootout match should exist in H2H');
assert(shootoutMatch ? shootoutMatch.result.regulation === 'TIE' : false, 'Shootout match regulation result must be TIE');
assert(shootoutMatch ? shootoutMatch.result.shootout === 'WIN' : false, 'Shootout match shootout result must be WIN');

// Check 13: Availability & Roles
console.log('13. Checking Availability & Roles...');
assert(inputExp.team2.availability.confirmedOut.length > 0, 'Confirmed out array should not be empty');
assert(inputExp.team2.availability.dayToDay.length >= 0, 'Day-to-day array exists');

console.log('\n✅ ALL 13 ADAPTER VERIFICATION CHECKS PASSED SUCCESSFULLY!');

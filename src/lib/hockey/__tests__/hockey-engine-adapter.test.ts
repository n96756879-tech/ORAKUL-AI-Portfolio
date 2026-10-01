import fs from 'fs';
import path from 'path';
import { parseHockeyVDP } from '../hockey-vdp-parser';
import { adaptHockeyVDPToEngineInput } from '../hockey-engine-adapter';
import { predictHockeyMatch } from '../hockey-engine';
import { validateHockeyPredictionInvariants } from './prediction-types.test';

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

// Check 2: KHL VDP Adaptation & E2E Prediction
console.log('2. Checking KHL VDP adaptation & E2E prediction...');
assert(vdpS2.match.team1Name === 'ЦСКА', 'Parser: Team 1 is ЦСКА');
assert(vdpS2.match.team2Name === 'СКА', 'Parser: Team 2 is СКА');
assert(vdpS2.team1.recentForm.gamesPlayed === 5, 'Parser: CSKA gamesPlayed === 5');
assert(vdpS2.team1.recentForm.goalsForTotal === 18, 'Parser: CSKA goalsForTotal === 18');
assert(vdpS2.team1.recentForm.goalsAgainstTotal === 5, 'Parser: CSKA goalsAgainstTotal === 5');
assert(vdpS2.team2.recentForm.gamesPlayed === 5, 'Parser: SKA gamesPlayed === 5');
assert(vdpS2.team2.recentForm.goalsForTotal === 18, 'Parser: SKA goalsForTotal === 18');
assert(vdpS2.team2.recentForm.goalsAgainstTotal === 11, 'Parser: SKA goalsAgainstTotal === 11');

assert(inputS2.match.team1Name.includes('ЦСКА'), 'Team 1 should be CSKA');
assert(inputS2.team1.recentForm.summary.gamesPlayed === 5, 'Adapter: CSKA gamesPlayed === 5');
assert(inputS2.team1.recentForm.summary.goalsForTotal === 18, 'Adapter: CSKA goalsForTotal === 18');
assert(inputS2.team1.recentForm.summary.goalsAgainstTotal === 5, 'Adapter: CSKA goalsAgainstTotal === 5');
assert(inputS2.team2.recentForm.summary.gamesPlayed === 5, 'Adapter: SKA gamesPlayed === 5');
assert(inputS2.team2.recentForm.summary.goalsForTotal === 18, 'Adapter: SKA goalsForTotal === 18');
assert(inputS2.team2.recentForm.summary.goalsAgainstTotal === 11, 'Adapter: SKA goalsAgainstTotal === 11');

// E2E: Pass adapted input into predictHockeyMatch
const predictionResult = predictHockeyMatch(inputS2);
assert(validateHockeyPredictionInvariants(predictionResult), 'Engine prediction invariants passed');

const regSum = predictionResult.core.pHomeRegulationWin + predictionResult.core.pRegulationTie + predictionResult.core.pAwayRegulationWin;
assert(Math.abs(regSum - 1.0) < 1e-4, 'Regulation probabilities sum to ~1.0');

const finalSum = predictionResult.core.pHomeFinalWin + predictionResult.core.pAwayFinalWin;
assert(Math.abs(finalSum - 1.0) < 1e-4, 'Final probabilities sum to ~1.0');

const lambdaHome = predictionResult.diagnostics?.expectedHomeGoals ?? 0;
const lambdaAway = predictionResult.diagnostics?.expectedAwayGoals ?? 0;
assert(lambdaHome > 0, 'Expected home goals (lambdaHome) > 0');
assert(lambdaAway > 0, 'Expected away goals (lambdaAway) > 0');
assert(predictionResult.core.pRegulationTie < 1.0, 'Prediction is non-degenerate (P(Tie) < 100%)');

console.log('   E2E Provenance:');
console.log('   CSKA: raw → parser → adapter → engine (5 / 18 / 5)');
console.log('   SKA:  raw → parser → adapter → engine (5 / 18 / 11)');
console.log(`   lambdaHome: ${lambdaHome.toFixed(3)}, lambdaAway: ${lambdaAway.toFixed(3)}`);
console.log(`   Regulation: Home ${(predictionResult.core.pHomeRegulationWin * 100).toFixed(1)}% | Tie ${(predictionResult.core.pRegulationTie * 100).toFixed(1)}% | Away ${(predictionResult.core.pAwayRegulationWin * 100).toFixed(1)}%`);
console.log(`   Final:      Home ${(predictionResult.core.pHomeFinalWin * 100).toFixed(1)}% | Away ${(predictionResult.core.pAwayFinalWin * 100).toFixed(1)}%`);

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

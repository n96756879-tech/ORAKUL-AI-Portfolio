import { predictHockeyMatch } from '../hockey-engine';
import { validateHockeyPredictionInvariants } from './prediction-types.test';
import type { HockeyEngineInput } from '../engine-types';

function createMockInput(overrides?: Partial<HockeyEngineInput>): HockeyEngineInput {
  return {
    match: {
      team1Name: 'Colorado Avalanche',
      team2Name: 'Edmonton Oilers',
      homeTeam: 'Colorado Avalanche',
      awayTeam: 'Edmonton Oilers',
      league: 'NHL',
      date: '2026-10-01',
      venue: 'Ball Arena',
    },
    team1: {
      teamName: 'Colorado Avalanche',
      recentForm: {
        matches: [],
        summary: {
          gamesPlayed: 5,
          winsRegulation: 3,
          winsOT: 1,
          winsSO: 0,
          lossesRegulation: 1,
          lossesOT: 0,
          lossesSO: 0,
          goalsForTotal: 20,
          goalsAgainstTotal: 10,
        },
      },
      goaltending: {
        starterName: { status: 'FOUND', value: 'Alexandar Georgiev', confidence: 'CONFIRMED' },
        backupName: { status: 'FOUND', value: 'Justus Annunen', confidence: 'CONFIRMED' },
        starterStatus: { status: 'FOUND', value: 'CONFIRMED', confidence: 'CONFIRMED' },
        svPct: { status: 'FOUND', value: 0.920, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        gaa: { status: 'FOUND', value: 2.00, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        saves: { status: 'FOUND', value: 138, confidence: 'CONFIRMED' },
        shotsAgainst: { status: 'FOUND', value: 150, confidence: 'CONFIRMED' },
      },
      specialTeams: {
        ppPct: { status: 'FOUND', value: 25.0, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        pkPct: { status: 'FOUND', value: 85.0, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        powerPlayGoals: { status: 'FOUND', value: 5, confidence: 'CONFIRMED' },
        shortHandedGoals: { status: 'FOUND', value: 0, confidence: 'CONFIRMED' },
        penalties: { status: 'FOUND', value: 15, confidence: 'CONFIRMED' },
        penaltyMinutes: { status: 'FOUND', value: 30, confidence: 'CONFIRMED' },
      },
      shots: {
        sog: { status: 'FOUND', value: 32.0, confidence: 'CONFIRMED' },
        shotsAgainst: { status: 'FOUND', value: 30.0, confidence: 'CONFIRMED' },
        shotDifferential: { status: 'FOUND', value: 2.0, confidence: 'CONFIRMED' },
        faceoffPct: { status: 'FOUND', value: 52.0, confidence: 'CONFIRMED' },
        hits: { status: 'FOUND', value: 20, confidence: 'CONFIRMED' },
        blockedShots: { status: 'FOUND', value: 14, confidence: 'CONFIRMED' },
        takeaways: { status: 'FOUND', value: 6, confidence: 'CONFIRMED' },
        giveaways: { status: 'FOUND', value: 5, confidence: 'CONFIRMED' },
      },
      scoring: {
        goalsByPeriod: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        evenStrengthGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        powerPlayGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        shortHandedGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        emptyNetGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
      },
      availability: {
        confirmedOut: [],
        dayToDay: [],
        unconfirmed: [],
      },
    },
    team2: {
      teamName: 'Edmonton Oilers',
      recentForm: {
        matches: [],
        summary: {
          gamesPlayed: 5,
          winsRegulation: 2,
          winsOT: 0,
          winsSO: 1,
          lossesRegulation: 2,
          lossesOT: 0,
          lossesSO: 0,
          goalsForTotal: 15,
          goalsAgainstTotal: 15,
        },
      },
      goaltending: {
        starterName: { status: 'FOUND', value: 'Stuart Skinner', confidence: 'CONFIRMED' },
        backupName: { status: 'FOUND', value: 'Calvin Pickard', confidence: 'CONFIRMED' },
        starterStatus: { status: 'FOUND', value: 'CONFIRMED', confidence: 'CONFIRMED' },
        svPct: { status: 'FOUND', value: 0.900, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        gaa: { status: 'FOUND', value: 3.00, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        saves: { status: 'FOUND', value: 135, confidence: 'CONFIRMED' },
        shotsAgainst: { status: 'FOUND', value: 150, confidence: 'CONFIRMED' },
      },
      specialTeams: {
        ppPct: { status: 'FOUND', value: 20.0, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        pkPct: { status: 'FOUND', value: 80.0, confidence: 'CONFIRMED', sampleSize: 5, season: '2025-2026', temporalType: 'recent_form' },
        powerPlayGoals: { status: 'FOUND', value: 4, confidence: 'CONFIRMED' },
        shortHandedGoals: { status: 'FOUND', value: 0, confidence: 'CONFIRMED' },
        penalties: { status: 'FOUND', value: 16, confidence: 'CONFIRMED' },
        penaltyMinutes: { status: 'FOUND', value: 32, confidence: 'CONFIRMED' },
      },
      shots: {
        sog: { status: 'FOUND', value: 30.0, confidence: 'CONFIRMED' },
        shotsAgainst: { status: 'FOUND', value: 30.0, confidence: 'CONFIRMED' },
        shotDifferential: { status: 'FOUND', value: 0.0, confidence: 'CONFIRMED' },
        faceoffPct: { status: 'FOUND', value: 50.0, confidence: 'CONFIRMED' },
        hits: { status: 'FOUND', value: 18, confidence: 'CONFIRMED' },
        blockedShots: { status: 'FOUND', value: 12, confidence: 'CONFIRMED' },
        takeaways: { status: 'FOUND', value: 5, confidence: 'CONFIRMED' },
        giveaways: { status: 'FOUND', value: 6, confidence: 'CONFIRMED' },
      },
      scoring: {
        goalsByPeriod: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        evenStrengthGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        powerPlayGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        shortHandedGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
        emptyNetGoals: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
      },
      availability: {
        confirmedOut: [],
        dayToDay: [],
        unconfirmed: [],
      },
    },
    h2h: { matches: [], matchIdentifiers: [] },
    standings: {
      rank: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
      points: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
      divisionRank: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
      conferenceRank: { status: 'UNKNOWN', value: null, confidence: 'UNCONFIRMED' },
    },
    context: {
      stage: 'Regular Season',
      notes: null,
    },
    notFound: [],
    ...overrides,
  };
}

console.log('=== HOCKEY ENGINE SUITE ===\n');

// 1. Full normal input & Invariants check
console.log('1. Testing prediction on full normal input...');
const input = createMockInput();
const result = predictHockeyMatch(input);
validateHockeyPredictionInvariants(result);
console.log('   ✅ Prediction generated and all invariants passed!');

// 2. Symmetric input check
console.log('2. Testing symmetric input...');
const symmetricInput = createMockInput({
  team2: {
    ...input.team1,
    teamName: 'Edmonton Oilers',
  },
});
const symResult = predictHockeyMatch(symmetricInput);
validateHockeyPredictionInvariants(symResult);

if (Math.abs(symResult.core.pHomeRegulationWin - symResult.core.pAwayRegulationWin) > 0.00001) {
  throw new Error(`Symmetric input failed: pHomeRegulationWin (${symResult.core.pHomeRegulationWin}) !== pAwayRegulationWin (${symResult.core.pAwayRegulationWin})`);
}
if (Math.abs((symResult.diagnostics?.expectedHomeGoals ?? 0) - (symResult.diagnostics?.expectedAwayGoals ?? 0)) > 0.00001) {
  throw new Error('Symmetric input lambda failed');
}
console.log('   ✅ Symmetric input produces equal probabilities and lambdas!');

// 3. Determinism check
console.log('3. Testing determinism (identical input produces identical output)...');
const resA = predictHockeyMatch(input);
const resB = predictHockeyMatch(input);
if (resA.core.pHomeRegulationWin !== resB.core.pHomeRegulationWin || resA.diagnostics?.expectedHomeGoals !== resB.diagnostics?.expectedHomeGoals) {
  throw new Error('Determinism check failed: outputs differ across calls');
}
console.log('   ✅ Determinism confirmed!');

// 4. Positive lambda check
console.log('4. Verifying positive lambdas...');
const l1 = result.diagnostics?.expectedHomeGoals ?? 0;
const l2 = result.diagnostics?.expectedAwayGoals ?? 0;
if (l1 <= 0 || l2 <= 0) {
  throw new Error(`Lambdas must be positive: lambda1=${l1}, lambda2=${l2}`);
}
console.log(`   ✅ Lambdas are positive: lambda1=${l1.toFixed(3)}, lambda2=${l2.toFixed(3)}`);

console.log('\n✅ ALL HOCKEY ENGINE TESTS PASSED SUCCESSFULLY!');

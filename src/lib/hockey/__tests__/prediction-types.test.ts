import type { HockeyPredictionResult } from '../prediction-types';

/**
 * Validates the mathematical invariants of a HockeyPredictionResult instance.
 * Returns true if valid, throws an Error with details if any invariant fails.
 */
export function validateHockeyPredictionInvariants(
  result: HockeyPredictionResult,
  tolerance: number = 1e-6
): boolean {
  const { core, conditionalOTSO } = result;

  // Helper for range check
  const inRange = (val: number, name: string) => {
    if (val < 0 - tolerance || val > 1 + tolerance) {
      throw new Error(`Invariant failed: ${name} = ${val} is out of range [0, 1]`);
    }
  };

  // 1. All probabilities range check [0, 1]
  inRange(core.pHomeRegulationWin, 'pHomeRegulationWin');
  inRange(core.pRegulationTie, 'pRegulationTie');
  inRange(core.pAwayRegulationWin, 'pAwayRegulationWin');
  inRange(core.pHomeFinalWin, 'pHomeFinalWin');
  inRange(core.pAwayFinalWin, 'pAwayFinalWin');
  inRange(conditionalOTSO.pHomeWinAfterTie, 'pHomeWinAfterTie');
  inRange(conditionalOTSO.pAwayWinAfterTie, 'pAwayWinAfterTie');

  // 2. Regulation Simplex: P1 + PT + P2 = 1
  const regSum = core.pHomeRegulationWin + core.pRegulationTie + core.pAwayRegulationWin;
  if (Math.abs(regSum - 1.0) > tolerance) {
    throw new Error(
      `Invariant failed: Regulation probabilities sum to ${regSum}, expected 1.0`
    );
  }

  // 3. Final Simplex: PF_home + PF_away = 1
  const finalSum = core.pHomeFinalWin + core.pAwayFinalWin;
  if (Math.abs(finalSum - 1.0) > tolerance) {
    throw new Error(
      `Invariant failed: Final probabilities sum to ${finalSum}, expected 1.0`
    );
  }

  // 4. Conditional OT/SO Simplex: P_home_after_tie + P_away_after_tie = 1
  const otSoSum = conditionalOTSO.pHomeWinAfterTie + conditionalOTSO.pAwayWinAfterTie;
  if (Math.abs(otSoSum - 1.0) > tolerance) {
    throw new Error(
      `Invariant failed: Conditional OT/SO probabilities sum to ${otSoSum}, expected 1.0`
    );
  }

  // 5. Identity Link Home: P(Home Final) = P(Home Reg) + P(Reg Tie) * P(Home Win After Tie)
  const expectedHomeFinal =
    core.pHomeRegulationWin + core.pRegulationTie * conditionalOTSO.pHomeWinAfterTie;
  if (Math.abs(core.pHomeFinalWin - expectedHomeFinal) > tolerance) {
    throw new Error(
      `Invariant failed: Home identity link check failed. pHomeFinalWin = ${core.pHomeFinalWin}, expected ${expectedHomeFinal}`
    );
  }

  // 6. Identity Link Away: P(Away Final) = P(Away Reg) + P(Reg Tie) * P(Away Win After Tie)
  const expectedAwayFinal =
    core.pAwayRegulationWin + core.pRegulationTie * conditionalOTSO.pAwayWinAfterTie;
  if (Math.abs(core.pAwayFinalWin - expectedAwayFinal) > tolerance) {
    throw new Error(
      `Invariant failed: Away identity link check failed. pAwayFinalWin = ${core.pAwayFinalWin}, expected ${expectedAwayFinal}`
    );
  }

  return true;
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function expectToThrow(fn: () => void, expectedPattern: RegExp) {
  let threw = false;
  try {
    fn();
  } catch (err: any) {
    threw = true;
    assert(
      expectedPattern.test(err.message),
      `Expected error matching ${expectedPattern}, but got "${err.message}"`
    );
  }
  assert(threw, `Expected function to throw, but it succeeded.`);
}

console.log('=== HOCKEY PREDICTION CONTRACT INVARIANTS TEST SUITE ===\n');

// Test 1: Valid synthetic prediction
console.log('1. Testing valid synthetic prediction...');
const validSynthetic: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 0.5,
    pRegulationTie: 0.2,
    pAwayRegulationWin: 0.3,
    pHomeFinalWin: 0.61, // 0.50 + 0.20 * 0.55 = 0.61
    pAwayFinalWin: 0.39, // 0.30 + 0.20 * 0.45 = 0.39
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.55,
    pAwayWinAfterTie: 0.45,
    detailedBreakdown: {
      pOvertimeHomeWinGivenTie: 0.35,
      pOvertimeAwayWinGivenTie: 0.25,
      pOvertimeUnresolvedGivenTie: 0.40,
      pShootoutHomeWinGivenOTUnresolved: 0.50,
      pShootoutAwayWinGivenOTUnresolved: 0.50,
    },
  },
  diagnostics: {
    expectedHomeGoals: 3.1,
    expectedAwayGoals: 2.3,
    scoreGrid: [
      { homeGoals: 3, awayGoals: 2, probability: 0.08 },
      { homeGoals: 2, awayGoals: 2, probability: 0.06 },
    ],
    rawModelParameters: {
      alphaHome: 1.15,
      betaAway: 0.92,
    },
  },
  metadata: {
    modelId: 'hockey-poisson-baseline',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
    calibrationVersion: 'v1-isotonic',
  },
};
assert(validateHockeyPredictionInvariants(validSynthetic) === true, 'Valid synthetic prediction should pass');

// Test 2: Regulation sum failure
console.log('2. Testing regulation sum failure...');
const invalidRegSum: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 0.5,
    pRegulationTie: 0.3, // Sum = 1.1!
    pAwayRegulationWin: 0.3,
    pHomeFinalWin: 0.65,
    pAwayFinalWin: 0.35,
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.5,
    pAwayWinAfterTie: 0.5,
  },
  metadata: {
    modelId: 'test-model',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
  },
};
expectToThrow(() => validateHockeyPredictionInvariants(invalidRegSum), /Regulation probabilities sum to 1.1/);

// Test 3: Final sum failure
console.log('3. Testing final sum failure...');
const invalidFinalSum: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 0.4,
    pRegulationTie: 0.2,
    pAwayRegulationWin: 0.4,
    pHomeFinalWin: 0.5,
    pAwayFinalWin: 0.6, // Sum = 1.1!
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.5,
    pAwayWinAfterTie: 0.5,
  },
  metadata: {
    modelId: 'test-model',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
  },
};
expectToThrow(() => validateHockeyPredictionInvariants(invalidFinalSum), /Final probabilities sum to 1.1/);

// Test 4: Conditional OT/SO sum failure
console.log('4. Testing conditional OT/SO sum failure...');
const invalidOtSoSum: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 0.4,
    pRegulationTie: 0.2,
    pAwayRegulationWin: 0.4,
    pHomeFinalWin: 0.5,
    pAwayFinalWin: 0.5,
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.6,
    pAwayWinAfterTie: 0.6, // Sum = 1.2!
  },
  metadata: {
    modelId: 'test-model',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
  },
};
expectToThrow(() => validateHockeyPredictionInvariants(invalidOtSoSum), /Conditional OT\/SO probabilities sum to 1.2/);

// Test 5: Identity link failure
console.log('5. Testing identity link failure...');
const identityViolated: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 0.4,
    pRegulationTie: 0.2,
    pAwayRegulationWin: 0.4,
    pHomeFinalWin: 0.6, // Expected 0.50, given 0.60
    pAwayFinalWin: 0.4,
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.5,
    pAwayWinAfterTie: 0.5,
  },
  metadata: {
    modelId: 'test-model',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
  },
};
expectToThrow(() => validateHockeyPredictionInvariants(identityViolated), /Home identity link check failed/);

// Test 6: Out of range failure
console.log('6. Testing out of range failure...');
const outOfRange: HockeyPredictionResult = {
  core: {
    pHomeRegulationWin: 1.2, // Out of range
    pRegulationTie: -0.1,
    pAwayRegulationWin: -0.1,
    pHomeFinalWin: 0.5,
    pAwayFinalWin: 0.5,
  },
  conditionalOTSO: {
    pHomeWinAfterTie: 0.5,
    pAwayWinAfterTie: 0.5,
  },
  metadata: {
    modelId: 'test-model',
    modelVersion: '1.0.0',
    predictionCutoff: '2026-09-29T18:00:00Z',
  },
};
expectToThrow(() => validateHockeyPredictionInvariants(outOfRange), /is out of range \[0, 1\]/);

console.log('\n✅ ALL 6 HOCKEY PREDICTION INVARIANTS TESTS PASSED SUCCESSFULLY!');

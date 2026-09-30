// -----------------------------------------------------------------------------
// 1. Core Model-Neutral Prediction
// -----------------------------------------------------------------------------

/**
 * Minimal required prediction probabilities that MUST be produced by any Hockey Probability Engine.
 *
 * Invariants:
 * 1. Range: All probabilities MUST be in [0, 1].
 * 2. Regulation Simplex: pHomeRegulationWin + pRegulationTie + pAwayRegulationWin = 1.0
 * 3. Final Simplex: pHomeFinalWin + pAwayFinalWin = 1.0
 */
export interface HockeyCorePrediction {
  /** Unconditional P(Home Win in Regulation / 60 mins) */
  pHomeRegulationWin: number;
  /** Unconditional P(Tie in Regulation / 60 mins) */
  pRegulationTie: number;
  /** Unconditional P(Away Win in Regulation / 60 mins) */
  pAwayRegulationWin: number;
  /** Unconditional P(Home Final Win including OT/SO) */
  pHomeFinalWin: number;
  /** Unconditional P(Away Final Win including OT/SO) */
  pAwayFinalWin: number;
}

// -----------------------------------------------------------------------------
// 2. Conditional Overtime / Shootout Outcomes
// -----------------------------------------------------------------------------

/**
 * Conditional probabilities for overtime and shootout outcomes given a regulation tie.
 *
 * Invariants:
 * 1. Simplex: pHomeWinAfterTie + pAwayWinAfterTie = 1.0
 * 2. Identity Link:
 *    pHomeFinalWin = pHomeRegulationWin + (pRegulationTie * pHomeWinAfterTie)
 *    pAwayFinalWin = pAwayRegulationWin + (pRegulationTie * pAwayWinAfterTie)
 */
export interface HockeyConditionalOTSO {
  /** P(Home Final Win | Regulation Tie) */
  pHomeWinAfterTie: number;
  /** P(Away Final Win | Regulation Tie) */
  pAwayWinAfterTie: number;

  /** Optional granular conditional breakdown if supported by the model */
  detailedBreakdown?: {
    /** P(Home OT Win | Regulation Tie) */
    pOvertimeHomeWinGivenTie?: number;
    /** P(Away OT Win | Regulation Tie) */
    pOvertimeAwayWinGivenTie?: number;
    /** P(OT Unresolved / Moves to SO | Regulation Tie) */
    pOvertimeUnresolvedGivenTie?: number;
    /** P(Home SO Win | OT Unresolved) */
    pShootoutHomeWinGivenOTUnresolved?: number;
    /** P(Away SO Win | OT Unresolved) */
    pShootoutAwayWinGivenOTUnresolved?: number;
  };
}

// -----------------------------------------------------------------------------
// 3. Optional Model-Specific Diagnostics
// -----------------------------------------------------------------------------

/**
 * Diagnostic outputs that MAY be provided by specific models (e.g., Poisson, Monte Carlo),
 * but are NOT required by the core model-neutral output contract.
 */
export interface HockeyModelDiagnostics {
  /** Expected goals for home team (lambda / xG) */
  expectedHomeGoals?: number;
  /** Expected goals for away team (lambda / xG) */
  expectedAwayGoals?: number;
  /** Optional exact score distribution matrix */
  scoreGrid?: Array<{
    homeGoals: number;
    awayGoals: number;
    probability: number;
  }>;
  /** Model-internal raw parameters (e.g. attack/defense ratings, variance, correlation) */
  rawModelParameters?: Record<string, number | string>;
}

// -----------------------------------------------------------------------------
// 4. Prediction Metadata
// -----------------------------------------------------------------------------

/**
 * Minimal neutral metadata required for prediction traceability and backtesting.
 */
export interface HockeyPredictionMetadata {
  /** Identifier of the model that generated this prediction */
  modelId: string;
  /** Semantic version or commit hash of the model */
  modelVersion: string;
  /** ISO 8601 timestamp cutoff for pre-match features used in this prediction */
  predictionCutoff: string;
  /** Optional version of calibration transformer applied */
  calibrationVersion?: string;
}

// -----------------------------------------------------------------------------
// 5. Root Prediction Result Contract
// -----------------------------------------------------------------------------

/**
 * Root contract combining core probabilities, conditional OT/SO breakdown,
 * optional model diagnostics, and prediction metadata.
 */
export interface HockeyPredictionResult {
  /** Mandatory core probabilities */
  core: HockeyCorePrediction;
  /** Mandatory conditional OT/SO probabilities */
  conditionalOTSO: HockeyConditionalOTSO;
  /** Optional diagnostics */
  diagnostics?: HockeyModelDiagnostics;
  /** Mandatory prediction metadata */
  metadata: HockeyPredictionMetadata;
}

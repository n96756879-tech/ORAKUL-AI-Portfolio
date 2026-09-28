export type GoalVenue = "HOME" | "AWAY" | "NEUTRAL" | "UNKNOWN";
export type GoalOpponentStrength = "STRONG" | "MEDIUM" | "WEAK" | "UNKNOWN";
export type GoalResult = "W" | "D" | "L" | "UNKNOWN";

export type GoalDistributionMatch = {
  goalsFor?: number;
  goalsAgainst?: number;
  result?: GoalResult;
  opponentStrength?: GoalOpponentStrength;
  venue?: GoalVenue;
};

export type GoalDistributionTeam = {
  matches: GoalDistributionMatch[];
  currentVenue?: GoalVenue;
  futureOpponentStrength?: GoalOpponentStrength;
};

export type GoalDistributionInput = {
  team1: GoalDistributionTeam;
  team2: GoalDistributionTeam;
  h2h?: unknown;
};

export const OVERFLOW_INDEX = 13 as const;
export const MAX_GOALS = 12 as const;

export type ScoreMatrix = {
  maxGoals: typeof MAX_GOALS;
  overflowIndex: typeof OVERFLOW_INDEX;
  cells: number[][];
  overflow: {
    team1: number[];
    team2: number[];
    both: number;
  };
  residual: number;
};

export type GoalDistributionMarkets = {
  result: {
    team1Win: number;
    draw: number;
    team2Win: number;
  };
  doubleChance: { oneX: number; xTwo: number };
  totals: {
    over15: number; under15: number;
    over25: number; under25: number;
    over35: number; under35: number;
  };
  btts: { yes: number; no: number };
  teamScoring: {
    team1Scores: number; team1DoesNotScore: number;
    team2Scores: number; team2DoesNotScore: number;
  };
  teamTotals: {
    team1Over05: number; team1Under05: number;
    team1Over15: number; team1Under15: number;
    team2Over05: number; team2Under05: number;
    team2Over15: number; team2Under15: number;
  };
};

export type GoalDistributionDiagnostics = {
  usedFallbacks: string[];
  validMatchCounts: { team1: number; team2: number };
  validGoalsForCounts: { team1: number; team2: number };
  validGoalsAgainstCounts: { team1: number; team2: number };
  maxGoals: typeof MAX_GOALS;
  residual: number;
};

export type GoalDistributionResult = {
  lambda1: number;
  lambda2: number;
  matrix: ScoreMatrix;
  markets: GoalDistributionMarkets;
  diagnostics: GoalDistributionDiagnostics;
};

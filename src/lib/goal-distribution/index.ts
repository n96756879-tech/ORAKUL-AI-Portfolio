import { calculateLambdas } from "./lambda";
import { buildScoreMatrix } from "./poisson";
import { calculateMarkets } from "./markets";
import type { GoalDistributionInput, GoalDistributionResult } from "./types";

export * from "./types";
export * from "./lambda";
export * from "./poisson";
export * from "./markets";

export function calculateGoalDistribution(input: GoalDistributionInput): GoalDistributionResult {
  const lambdas = calculateLambdas(input);
  const matrix = buildScoreMatrix(lambdas.lambda1, lambdas.lambda2);
  return { lambda1: lambdas.lambda1, lambda2: lambdas.lambda2, matrix, markets: calculateMarkets(matrix), diagnostics: { usedFallbacks: lambdas.diagnostics.fallbacks, validMatchCounts: { team1: lambdas.diagnostics.validMatchCounts[0], team2: lambdas.diagnostics.validMatchCounts[1] }, validGoalsForCounts: { team1: lambdas.diagnostics.validGoalsForCounts[0], team2: lambdas.diagnostics.validGoalsForCounts[1] }, validGoalsAgainstCounts: { team1: lambdas.diagnostics.validGoalsAgainstCounts[0], team2: lambdas.diagnostics.validGoalsAgainstCounts[1] }, maxGoals: matrix.maxGoals, residual: matrix.residual } };
}

import type { HockeyEngineInput } from './engine-types';
import type { HockeyPredictionResult } from './prediction-types';

/** Technical baseline maximum goals for the Poisson score grid */
const MAX_GRID_GOALS = 10;

/**
 * Calculates Poisson Probability Mass Function (PMF): P(X = k) = (lambda^k * e^-lambda) / k!
 */
function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let fact = 1;
  for (let i = 2; i <= k; i++) {
    fact *= i;
  }
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / fact;
}

/**
 * Extracts average attack (goalsFor per game) and defense (goalsAgainst per game) for a team.
 * Follows missing data semantics: FOUND + numeric value is used from recentForm summary.
 */
function getTeamRates(teamInput: HockeyEngineInput['team1']): { attack: number; defense: number; games: number } {
  const formSummary = teamInput.recentForm.summary;
  if (formSummary && formSummary.gamesPlayed > 0) {
    const games = formSummary.gamesPlayed;
    const attack = formSummary.goalsForTotal / games;
    const defense = formSummary.goalsAgainstTotal / games;
    return { attack, defense, games };
  }

  throw new Error(
    `[HockeyEngine] Insufficient data to calculate attack/defense rates for team: ${teamInput.teamName}. ` +
    `recentForm.summary was missing or had 0 games played.`
  );
}

/**
 * Computes data completeness score in range [0, 1] based on required metrics present for baseline.
 */
function computeDataCompleteness(input: HockeyEngineInput): number {
  let present = 0;
  let total = 4; // 2 form summaries + 2 goalie status entries

  if (input.team1.recentForm.summary?.gamesPlayed > 0) present++;
  if (input.team2.recentForm.summary?.gamesPlayed > 0) present++;
  if (input.team1.goaltending.starterStatus.status === 'FOUND') present++;
  if (input.team2.goaltending.starterStatus.status === 'FOUND') present++;

  return Math.round((present / total) * 100) / 100;
}

/**
 * Minimal deterministic Hockey Probability Engine v1.
 *
 * Implements Independent Poisson Baseline:
 * 1. attack1 = average goalsFor, defense1 = average goalsAgainst
 * 2. attack2 = average goalsFor, defense2 = average goalsAgainst
 * 3. lambda1 = (attack1 + defense2) / 2
 * 4. lambda2 = (attack2 + defense1) / 2
 * 5. Independent Poisson score grid (0..10 goals)
 * 6. Regulation probabilities aggregated from grid and normalized to sum to 1.0
 * 7. Conditional OT/SO baseline: P(team1Win | tie) = 0.5, P(team2Win | tie) = 0.5
 * 8. Final probabilities: regulation.teamWin + regulation.draw * 0.5
 */
export function predictHockeyMatch(input: HockeyEngineInput): HockeyPredictionResult {
  const team1Rates = getTeamRates(input.team1);
  const team2Rates = getTeamRates(input.team2);

  // Baseline lambda calculation
  const lambda1 = (team1Rates.attack + team2Rates.defense) / 2;
  const lambda2 = (team2Rates.attack + team1Rates.defense) / 2;

  // Build Poisson score grid
  const scoreGrid: Array<{ homeGoals: number; awayGoals: number; probability: number }> = [];
  let rawRegTeam1Win = 0;
  let rawRegDraw = 0;
  let rawRegTeam2Win = 0;
  let totalGridMass = 0;

  for (let h = 0; h <= MAX_GRID_GOALS; h++) {
    const probH = poissonPmf(h, lambda1);
    for (let a = 0; a <= MAX_GRID_GOALS; a++) {
      const probA = poissonPmf(a, lambda2);
      const probCell = probH * probA;
      totalGridMass += probCell;

      scoreGrid.push({
        homeGoals: h,
        awayGoals: a,
        probability: probCell,
      });

      if (h > a) {
        rawRegTeam1Win += probCell;
      } else if (h === a) {
        rawRegDraw += probCell;
      } else {
        rawRegTeam2Win += probCell;
      }
    }
  }

  // Normalize regulation probabilities so sum === 1.0
  const pHomeRegulationWin = rawRegTeam1Win / totalGridMass;
  const pRegulationTie = rawRegDraw / totalGridMass;
  const pAwayRegulationWin = rawRegTeam2Win / totalGridMass;

  // OT/SO Baseline assumption: 50/50 split on tie
  const pHomeWinAfterTie = 0.5;
  const pAwayWinAfterTie = 0.5;

  // Final probabilities via Identity Link
  const pHomeFinalWin = pHomeRegulationWin + pRegulationTie * pHomeWinAfterTie;
  const pAwayFinalWin = pAwayRegulationWin + pRegulationTie * pAwayWinAfterTie;

  const dataCompletenessScore = computeDataCompleteness(input);

  return {
    core: {
      pHomeRegulationWin,
      pRegulationTie,
      pAwayRegulationWin,
      pHomeFinalWin,
      pAwayFinalWin,
    },
    conditionalOTSO: {
      pHomeWinAfterTie,
      pAwayWinAfterTie,
    },
    diagnostics: {
      expectedHomeGoals: lambda1,
      expectedAwayGoals: lambda2,
      scoreGrid,
      rawModelParameters: {
        lambda1,
        lambda2,
        goalieAdjustmentApplied: 'false',
        availabilityAdjustmentApplied: 'false',
        dataCompletenessScore,
      },
    },
    metadata: {
      modelId: 'hockey-poisson-baseline',
      modelVersion: 'hockey-poisson-baseline-v1',
      predictionCutoff: new Date().toISOString(),
    },
  };
}

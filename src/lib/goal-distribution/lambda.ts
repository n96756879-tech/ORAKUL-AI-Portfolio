import type {
  GoalDistributionInput,
  GoalDistributionMatch,
  GoalDistributionTeam,
  GoalOpponentStrength,
  GoalVenue,
} from "./types";

export const LEAGUE_AVG_GOALS_PER_TEAM = 1.35;
export const MIN_LAMBDA = 0.15;
export const MAX_LAMBDA = 3.5;
export const SHRINKAGE_K = 5;

const HISTORICAL_STRENGTH: Record<GoalOpponentStrength, number> = {
  STRONG: 1.15, MEDIUM: 1, WEAK: 0.85, UNKNOWN: 1,
};
const FUTURE_STRENGTH: Record<GoalOpponentStrength, number> = {
  STRONG: 1.1, MEDIUM: 1, WEAK: 0.9, UNKNOWN: 1,
};

export type LambdaDiagnostics = {
  fallbacks: string[];
  validMatchCounts: [number, number];
  validGoalsForCounts: [number, number];
  validGoalsAgainstCounts: [number, number];
};

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function shrink(observed: number | null, count: number): number {
  if (observed === null || count === 0) return LEAGUE_AVG_GOALS_PER_TEAM;
  const observedWeight = count / (count + SHRINKAGE_K);
  return observedWeight * observed + (1 - observedWeight) * LEAGUE_AVG_GOALS_PER_TEAM;
}

function stats(matches: GoalDistributionMatch[]) {
  const validMatches = matches.filter((m) => validNumber(m.goalsFor) && validNumber(m.goalsAgainst));
  const gfValues = matches.flatMap((m) => {
    const goalsFor = m.goalsFor;
    return validNumber(goalsFor) ? [goalsFor / HISTORICAL_STRENGTH[m.opponentStrength ?? "UNKNOWN"]] : [];
  });
  const gaValues = matches.flatMap((m) => {
    const goalsAgainst = m.goalsAgainst;
    return validNumber(goalsAgainst) ? [goalsAgainst / HISTORICAL_STRENGTH[m.opponentStrength ?? "UNKNOWN"]] : [];
  });
  const gf = gfValues.length ? gfValues.reduce((a, b) => a + b, 0) / gfValues.length : null;
  const ga = gaValues.length ? gaValues.reduce((a, b) => a + b, 0) / gaValues.length : null;
  const formRate = validMatches.length
    ? (3 * validMatches.filter((m) => m.result === "W").length + validMatches.filter((m) => m.result === "D").length)
      / (3 * validMatches.length)
    : 0.5;
  return { validMatches, gf: shrink(gf, gfValues.length), ga: shrink(ga, gaValues.length), formRate, gfCount: gfValues.length, gaCount: gaValues.length };
}

function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

function venueMultiplier(team: GoalDistributionTeam, venue: GoalVenue | undefined, fallback: Set<string>, key: string) {
  if (!venue || venue === "UNKNOWN") { fallback.add(key); return 1; }
  const matches = team.matches.filter((m) => m.venue === venue && validNumber(m.goalsFor) && validNumber(m.goalsAgainst));
  if (matches.length < 2) { fallback.add(key); return 1; }
  const deltas = matches.flatMap((m) => {
    const { goalsFor, goalsAgainst } = m;
    return validNumber(goalsFor) && validNumber(goalsAgainst) ? [goalsFor - goalsAgainst] : [];
  });
  const delta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const shrunk = matches.length / (matches.length + SHRINKAGE_K) * delta;
  return Math.exp(clamp(0.05 * shrunk, -0.08, 0.08));
}

function opponentMultiplier(strength: GoalOpponentStrength | undefined) {
  return 1 / FUTURE_STRENGTH[strength ?? "UNKNOWN"];
}

export function calculateLambdas(input: GoalDistributionInput): { lambda1: number; lambda2: number; diagnostics: LambdaDiagnostics } {
  const fallbackSet = new Set<string>();
  const s1 = stats(input.team1.matches);
  const s2 = stats(input.team2.matches);
  if (!s1.validMatches.length) fallbackSet.add("team1-form");
  if (!s2.validMatches.length) fallbackSet.add("team2-form");
  if (!s1.gfCount) fallbackSet.add("team1-goalsFor");
  if (!s2.gfCount) fallbackSet.add("team2-goalsFor");
  if (!s1.gaCount) fallbackSet.add("team1-goalsAgainst");
  if (!s2.gaCount) fallbackSet.add("team2-goalsAgainst");
  const v1 = venueMultiplier(input.team1, input.team1.currentVenue, fallbackSet, "team1-venue");
  const v2 = venueMultiplier(input.team2, input.team2.currentVenue, fallbackSet, "team2-venue");
  const raw1 = LEAGUE_AVG_GOALS_PER_TEAM
    * (s1.gf / LEAGUE_AVG_GOALS_PER_TEAM)
    * (s2.ga / LEAGUE_AVG_GOALS_PER_TEAM)
    * (0.85 + 0.3 * s1.formRate)
    * (1.15 - 0.3 * s2.formRate)
    * v1 * opponentMultiplier(input.team2.futureOpponentStrength);
  const raw2 = LEAGUE_AVG_GOALS_PER_TEAM
    * (s2.gf / LEAGUE_AVG_GOALS_PER_TEAM)
    * (s1.ga / LEAGUE_AVG_GOALS_PER_TEAM)
    * (0.85 + 0.3 * s2.formRate)
    * (1.15 - 0.3 * s1.formRate)
    * v2 * opponentMultiplier(input.team1.futureOpponentStrength);
  const safe = (value: number, key: string) => {
    if (!Number.isFinite(value)) { fallbackSet.add(key); return LEAGUE_AVG_GOALS_PER_TEAM; }
    return clamp(value, MIN_LAMBDA, MAX_LAMBDA);
  };
  return {
    lambda1: safe(raw1, "lambda1"), lambda2: safe(raw2, "lambda2"),
    diagnostics: { fallbacks: [...fallbackSet].sort(), validMatchCounts: [s1.validMatches.length, s2.validMatches.length], validGoalsForCounts: [s1.gfCount, s2.gfCount], validGoalsAgainstCounts: [s1.gaCount, s2.gaCount] },
  };
}

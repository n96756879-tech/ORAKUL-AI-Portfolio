import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GOALS,
  OVERFLOW_INDEX,
  buildScoreMatrix,
  poissonSeries,
  calculateGoalDistribution,
  calculateMarkets,
} from "../src/lib/goal-distribution";

const EPS = 1e-10;
const close = (actual: number, expected: number, tolerance = EPS) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const empty = () => ({ team1: { matches: [] }, team2: { matches: [] } });
const sumMatrix = (matrix: ReturnType<typeof buildScoreMatrix>) => matrix.cells.flat().reduce((a, b) => a + b, 0);

describe("Goal Distribution Layer", () => {
  test("is deterministic and uses the neutral prior with no data", () => {
    const first = calculateGoalDistribution(empty());
    const second = calculateGoalDistribution(empty());
    assert.deepEqual(first, second);
    close(first.lambda1, 1.35);
    close(first.lambda2, 1.35);
    assert.ok(first.diagnostics.usedFallbacks.length > 0);
  });

  test("validates partial, negative, NaN, and infinite goals independently", () => {
    const result = calculateGoalDistribution({
      team1: { matches: [{ goalsFor: 2, goalsAgainst: -1 }, { goalsAgainst: 1 }, { goalsFor: Number.NaN }, { goalsFor: Number.POSITIVE_INFINITY, goalsAgainst: 1 }] },
      team2: { matches: [{ goalsFor: 1, goalsAgainst: 0 }] },
    });
    assert.equal(result.diagnostics.validGoalsForCounts.team1, 1);
    assert.equal(result.diagnostics.validGoalsAgainstCounts.team1, 2);
    assert.equal(result.diagnostics.validMatchCounts.team1, 0);
    assert.ok(Number.isFinite(result.lambda1));
    assert.ok(Number.isFinite(result.lambda2));
  });

  test("applies historical strength, form, and future opponent strength", () => {
    const base = { team1: { matches: [{ goalsFor: 2, goalsAgainst: 1, result: "W" as const, opponentStrength: "MEDIUM" as const }] }, team2: { matches: [{ goalsFor: 1, goalsAgainst: 2, result: "L" as const, opponentStrength: "MEDIUM" as const }] } };
    const strongOpponent = calculateGoalDistribution({ ...base, team2: { ...base.team2, futureOpponentStrength: "STRONG" } });
    const weakOpponent = calculateGoalDistribution({ ...base, team2: { ...base.team2, futureOpponentStrength: "WEAK" } });
    assert.ok(strongOpponent.lambda1 < weakOpponent.lambda1);
    assert.ok(strongOpponent.lambda1 >= 0.15 && strongOpponent.lambda1 <= 3.5);
  });

  test("uses venue profile only when current venue is explicit and sufficiently sampled", () => {
    const matches = [1, 2].map(() => ({ goalsFor: 3, goalsAgainst: 0, venue: "HOME" as const, result: "W" as const }));
    const explicit = calculateGoalDistribution({ team1: { matches, currentVenue: "HOME" }, team2: { matches: [] } });
    const absent = calculateGoalDistribution({ team1: { matches }, team2: { matches: [] } });
    assert.ok(explicit.lambda1 > absent.lambda1);
    assert.equal(absent.diagnostics.usedFallbacks.includes("team1-venue"), true);
  });

  test("H2H is ignored and no historical venue becomes current venue", () => {
    const input = { team1: { matches: [{ goalsFor: 2, goalsAgainst: 1, venue: "HOME" as const }] }, team2: { matches: [{ goalsFor: 1, goalsAgainst: 2, venue: "AWAY" as const }] } };
    const withH2H = calculateGoalDistribution({ ...input, h2h: [{ winner: "anything" }] });
    const withoutH2H = calculateGoalDistribution(input);
    assert.deepEqual(withH2H, withoutH2H);
    assert.equal(withoutH2H.diagnostics.usedFallbacks.includes("team1-venue"), true);
  });

  test("clamps extreme lambdas and keeps them finite", () => {
    const matches = Array.from({ length: 20 }, () => ({ goalsFor: 1000, goalsAgainst: 0, result: "W" as const }));
    const result = calculateGoalDistribution({ team1: { matches }, team2: { matches: [{ goalsFor: 0, goalsAgainst: 1000, result: "L" as const }] } });
    assert.equal(result.lambda1, 3.5);
    assert.ok(result.lambda2 >= 0.15 && result.lambda2 <= 3.5);
  });

  test("uses the literal historical strength constants", () => {
    const make = (strength: "STRONG" | "MEDIUM" | "WEAK" | "UNKNOWN") => calculateGoalDistribution({
      team1: { matches: [{ goalsFor: 2, goalsAgainst: 1, opponentStrength: strength }] },
      team2: { matches: [] },
    });
    const strong = make("STRONG");
    const medium = make("MEDIUM");
    const weak = make("WEAK");
    const unknown = make("UNKNOWN");
    assert.ok(strong.lambda1 < medium.lambda1);
    assert.ok(medium.lambda1 < weak.lambda1);
    close(unknown.lambda1, medium.lambda1);
  });

  test("keeps W/D/L form adjustments bounded", () => {
    const make = (result: "W" | "D" | "L") => calculateGoalDistribution({
      team1: { matches: [{ goalsFor: 1, goalsAgainst: 1, result }, { goalsFor: 1, goalsAgainst: 1, result }] },
      team2: { matches: [] },
    });
    const win = make("W");
    const draw = make("D");
    const loss = make("L");
    assert.ok(win.lambda1 > draw.lambda1 && draw.lambda1 > loss.lambda1);
    for (const value of [win.lambda1, draw.lambda1, loss.lambda1]) assert.ok(value >= 0.15 && value <= 3.5);
  });

  test("handles explicit neutral, unknown, and insufficient venue profiles", () => {
    const oneHome = [{ goalsFor: 3, goalsAgainst: 0, venue: "HOME" as const }, { goalsFor: 3, goalsAgainst: 0, venue: "HOME" as const }];
    const neutral = calculateGoalDistribution({ team1: { matches: oneHome, currentVenue: "NEUTRAL" }, team2: { matches: [] } });
    const unknown = calculateGoalDistribution({ team1: { matches: oneHome, currentVenue: "UNKNOWN" }, team2: { matches: [] } });
    const insufficient = calculateGoalDistribution({ team1: { matches: oneHome.slice(0, 1), currentVenue: "HOME" }, team2: { matches: [] } });
    close(neutral.lambda1, unknown.lambda1);
    assert.ok(Math.abs(insufficient.lambda1 - unknown.lambda1) > EPS);
  });

  test("builds recurrence-based matrix with explicit overflow accounting", () => {
    const matrix = buildScoreMatrix(1.5, 1.1);
    assert.equal(matrix.maxGoals, MAX_GOALS);
    assert.equal(matrix.cells.length, OVERFLOW_INDEX + 1);
    assert.equal(matrix.cells[0].length, OVERFLOW_INDEX + 1);
    assert.ok(matrix.overflow.team1.length === OVERFLOW_INDEX);
    assert.ok(matrix.overflow.team2.length === OVERFLOW_INDEX);
    assert.ok(matrix.cells.flat().every((value) => Number.isFinite(value) && value >= 0));
    close(sumMatrix(matrix), 1, 1e-12);
    close(matrix.residual, 0, 1e-12);
    close(matrix.cells[0][0], 0.07427357821433386, 1e-12);
    close(matrix.cells[0][1], 0.08170093603576725, 1e-12);
    close(matrix.cells[1][0], 0.1114103673215008, 1e-12);
    close(matrix.cells[1][1], 0.1225514040536509, 1e-12);
  });

  test("uses safe fallback and clamp for direct Poisson entrypoints", () => {
    close(poissonSeries(Number.NaN)[0], poissonSeries(1.35)[0]);
    close(poissonSeries(Number.POSITIVE_INFINITY)[0], poissonSeries(1.35)[0]);
    close(poissonSeries(-1)[0], poissonSeries(1.35)[0]);
    assert.deepEqual(buildScoreMatrix(Number.NaN, 1.35), buildScoreMatrix(1.35, 1.35));
    assert.deepEqual(buildScoreMatrix(Number.POSITIVE_INFINITY, 1.35), buildScoreMatrix(1.35, 1.35));
    assert.ok(buildScoreMatrix(999, 1.35).cells[1][0] < buildScoreMatrix(3.5, 1.35).cells[1][0] + 1e-12);
    assert.ok(buildScoreMatrix(0, 1.35).cells[1][0] >= 0);
  });

  test("aggregates result outcomes directly, including overflow comparisons", () => {
    const matrix = { maxGoals: MAX_GOALS, overflowIndex: OVERFLOW_INDEX, cells: Array.from({ length: 14 }, () => Array(14).fill(0)), overflow: { team1: Array(13).fill(0), team2: Array(13).fill(0), both: 0 }, residual: 0 };
    matrix.cells[OVERFLOW_INDEX][12] = 0.2;
    matrix.cells[12][OVERFLOW_INDEX] = 0.3;
    matrix.cells[OVERFLOW_INDEX][OVERFLOW_INDEX] = 0.1;
    matrix.cells[1][2] = 0.4;
    const markets = calculateMarkets(matrix);
    close(markets.result.team1Win, 0.2);
    close(markets.result.team2Win, 0.3 + 0.4);
    close(markets.result.draw, 0.1);
    close(markets.totals.over15, 1);
    close(markets.btts.yes, 0.2 + 0.3 + 0.1 + 0.4);
    close(markets.teamScoring.team1Scores, 1);
    close(markets.teamScoring.team2Scores, 1);
  });

  test("preserves recurrence consistency", () => {
    const series = poissonSeries(1.5);
    for (let i = 1; i < series.length; i += 1) close(series[i], series[i - 1] * 1.5 / i);
  });

  test("preserves symmetry and monotonic market behavior", () => {
    const symmetric = calculateGoalDistribution({ team1: { matches: [] }, team2: { matches: [] } });
    for (let i = 0; i <= OVERFLOW_INDEX; i += 1) for (let j = 0; j <= OVERFLOW_INDEX; j += 1) close(symmetric.matrix.cells[i][j], symmetric.matrix.cells[j][i]);
    close(symmetric.markets.result.team1Win, symmetric.markets.result.team2Win);
    const low = calculateGoalDistribution({ team1: { matches: [{ goalsFor: 0, goalsAgainst: 1, result: "L" }] }, team2: { matches: [] } });
    const high = calculateGoalDistribution({ team1: { matches: [{ goalsFor: 4, goalsAgainst: 1, result: "W" }] }, team2: { matches: [] } });
    assert.ok(high.markets.teamScoring.team1Scores >= low.markets.teamScoring.team1Scores);
  });

  test("derives all markets from one matrix and preserves complements", () => {
    const markets = calculateGoalDistribution({ team1: { matches: [] }, team2: { matches: [] } }).markets;
    close(markets.result.team1Win + markets.result.draw + markets.result.team2Win, 1);
    close(markets.doubleChance.oneX + markets.result.team2Win, 1);
    close(markets.result.team1Win + markets.doubleChance.xTwo, 1);
    close(markets.totals.over15 + markets.totals.under15, 1);
    close(markets.totals.over25 + markets.totals.under25, 1);
    close(markets.totals.over35 + markets.totals.under35, 1);
    close(markets.btts.yes + markets.btts.no, 1);
    close(markets.teamScoring.team1Scores + markets.teamScoring.team1DoesNotScore, 1);
    close(markets.teamScoring.team2Scores + markets.teamScoring.team2DoesNotScore, 1);
    assert.ok(markets.totals.over35 <= markets.totals.over25);
    assert.ok(markets.totals.over25 <= markets.totals.over15);
    assert.ok(markets.teamTotals.team1Over15 <= markets.teamTotals.team1Over05);
    assert.ok(markets.btts.yes <= markets.teamScoring.team1Scores);
    assert.ok(markets.btts.yes <= markets.teamScoring.team2Scores);
  });

  test("matches the illustrative Poisson market values", () => {
    const matrix = buildScoreMatrix(1.5, 1.1);
    const markets = calculateMarkets(matrix);
    const p00 = matrix.cells[0][0];
    const p01 = matrix.cells[0][1];
    const p10 = matrix.cells[1][0];
    const p11 = matrix.cells[1][1];
    close(p00, 0.07427357821433386, 1e-12);
    close(p01, 0.08170093603576725, 1e-12);
    close(p10, 0.1114103673215008, 1e-12);
    close(p11, 0.1225514040536509, 1e-12);
    close(markets.result.team1Win, 0.464244, 1e-5);
    close(markets.result.draw, 0.257667, 1e-5);
    close(markets.result.team2Win, 0.278089, 1e-5);
    close(markets.totals.over25, 0.481570, 1e-5);
    close(markets.btts.yes, 0.518272, 1e-5);
    close(markets.teamScoring.team1Scores, 0.776870, 1e-5);
    close(markets.teamScoring.team2Scores, 0.667129, 1e-5);
  });
});

import type { GoalDistributionMarkets, ScoreMatrix } from "./types";
import { OVERFLOW_INDEX } from "./types";

export const EPSILON = 1e-12;
const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const complement = (value: number) => clamp(1 - value);

function goals(index: number) { return index === OVERFLOW_INDEX ? 13 : index; }
function isOverflow(index: number) { return index === OVERFLOW_INDEX; }
function sum(matrix: ScoreMatrix, predicate: (i: number, j: number) => boolean) {
  return clamp(matrix.cells.reduce((total, row, i) => total + row.reduce((rowTotal, value, j) => rowTotal + (predicate(i, j) ? value : 0), 0), 0));
}

export function calculateMarkets(matrix: ScoreMatrix): GoalDistributionMarkets {
  const team1Win = sum(matrix, (i, j) => i > j);
  const draw = sum(matrix, (i, j) => i === j);
  const team2Win = sum(matrix, (i, j) => i < j);
  const over15 = sum(matrix, (i, j) => isOverflow(i) || isOverflow(j) || goals(i) + goals(j) >= 2);
  const over25 = sum(matrix, (i, j) => isOverflow(i) || isOverflow(j) || goals(i) + goals(j) >= 3);
  const over35 = sum(matrix, (i, j) => isOverflow(i) || isOverflow(j) || goals(i) + goals(j) >= 4);
  const btts = sum(matrix, (i, j) => i >= 1 && j >= 1);
  const t1Scores = sum(matrix, (i) => i >= 1);
  const t2Scores = sum(matrix, (_, j) => j >= 1);
  const t1Over15 = sum(matrix, (i) => i >= 2);
  const t2Over15 = sum(matrix, (_, j) => j >= 2);
  return {
    result: { team1Win, draw, team2Win },
    doubleChance: { oneX: clamp(team1Win + draw), xTwo: clamp(draw + team2Win) },
    totals: { over15, under15: complement(over15), over25, under25: complement(over25), over35, under35: complement(over35) },
    btts: { yes: btts, no: complement(btts) },
    teamScoring: { team1Scores: t1Scores, team1DoesNotScore: complement(t1Scores), team2Scores: t2Scores, team2DoesNotScore: complement(t2Scores) },
    teamTotals: { team1Over05: t1Scores, team1Under05: complement(t1Scores), team1Over15: t1Over15, team1Under15: complement(t1Over15), team2Over05: t2Scores, team2Under05: complement(t2Scores), team2Over15: t2Over15, team2Under15: complement(t2Over15) },
  };
}

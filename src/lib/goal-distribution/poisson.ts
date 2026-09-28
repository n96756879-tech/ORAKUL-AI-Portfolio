import { MAX_GOALS, OVERFLOW_INDEX } from "./types";
import type { ScoreMatrix } from "./types";
const EPSILON = 1e-12;
const DEFAULT_LAMBDA = 1.35;
const MIN_LAMBDA = 0.15;
const MAX_LAMBDA = 3.5;

function safeLambda(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) return DEFAULT_LAMBDA;
  return Math.min(MAX_LAMBDA, Math.max(MIN_LAMBDA, lambda));
}

export function poissonSeries(lambda: number): number[] {
  const safe = safeLambda(lambda);
  const values = [Math.exp(-safe)];
  for (let i = 1; i <= MAX_GOALS; i += 1) values.push(values[i - 1] * safe / i);
  return values;
}

export function buildScoreMatrix(lambda1: number, lambda2: number): ScoreMatrix {
  const p1 = poissonSeries(lambda1);
  const p2 = poissonSeries(lambda2);
  const tail1 = Math.max(0, 1 - p1.reduce((a, b) => a + b, 0));
  const tail2 = Math.max(0, 1 - p2.reduce((a, b) => a + b, 0));
  const cells = Array.from({ length: OVERFLOW_INDEX + 1 }, () => Array<number>(OVERFLOW_INDEX + 1).fill(0));
  for (let i = 0; i <= MAX_GOALS; i += 1) for (let j = 0; j <= MAX_GOALS; j += 1) cells[i][j] = p1[i] * p2[j];
  for (let j = 0; j <= MAX_GOALS; j += 1) cells[OVERFLOW_INDEX][j] = tail1 * p2[j];
  for (let i = 0; i <= MAX_GOALS; i += 1) cells[i][OVERFLOW_INDEX] = p1[i] * tail2;
  cells[OVERFLOW_INDEX][OVERFLOW_INDEX] = tail1 * tail2;
  const sum = cells.flat().reduce((a, b) => a + b, 0);
  const residual = 1 - sum;
  return { maxGoals: MAX_GOALS, overflowIndex: OVERFLOW_INDEX, cells, overflow: { team1: cells[OVERFLOW_INDEX].slice(0, OVERFLOW_INDEX), team2: cells.slice(0, OVERFLOW_INDEX).map((row) => row[OVERFLOW_INDEX]), both: cells[OVERFLOW_INDEX][OVERFLOW_INDEX] }, residual: Math.abs(residual) <= EPSILON ? 0 : residual };
}

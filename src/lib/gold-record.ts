import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedVDP } from "./vdp-parser";
import type { ProbabilityResult, ProbabilityEngineTrace } from "./probability-engine";

export type GoldRecord = {
  id: string;
  generatedAt: string;
  preMatchDataCutoff: string;
  team1: string | null;
  team2: string | null;
  matchDate: string | null;
  competition: string | null;
  pipelineVersion?: string;
  preMatch: ParsedVDP;
  engineOutput: {
    probabilities: ProbabilityResult;
    trace: ProbabilityEngineTrace;
  };
  actual: null;
};

export function getGoldRecordsPath(baseDir: string = process.cwd()) {
  return {
    dir: join(baseDir, "data", "historical"),
    file: join(baseDir, "data", "historical", "gold-records.jsonl"),
  };
}

export function persistGoldRecord(record: GoldRecord, baseDir: string = process.cwd()): void {
  const { dir, file } = getGoldRecordsPath(baseDir);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[ORAKUL GOLD] Failed to persist Gold Record:", err);
  }
}

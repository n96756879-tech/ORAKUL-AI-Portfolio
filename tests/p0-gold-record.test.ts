import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { GoldRecord } from '../src/lib/gold-record';

describe('Gold Record capture', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'gold-test-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('persistGoldRecord writes valid JSONL with actual=null', async () => {
    const { persistGoldRecord } = await import('../src/lib/gold-record');
    const record: GoldRecord = {
      id: 'test-id-1',
      generatedAt: '2026-10-05T12:00:00.000Z',
      preMatchDataCutoff: '2026-10-05T12:00:00.000Z',
      team1: 'Team A',
      team2: 'Team B',
      matchDate: null,
      competition: null,
      preMatch: {
        team1: { teamName: 'Team A', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
        team2: { teamName: 'Team B', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
        h2h: [],
        currentVenue: 'UNKNOWN',
      },
      engineOutput: {
        probabilities: { team1: 40, draw: 30, team2: 30 },
        trace: {} as any,
      },
      actual: null,
    };

persistGoldRecord(record, tempDir);

    const filePath = join(tempDir, 'data', 'historical', 'gold-records.jsonl');
    const content = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(content);

    assert.equal(parsed.id, 'test-id-1');
    assert.equal(parsed.actual, null);
    assert.equal(parsed.generatedAt, parsed.preMatchDataCutoff);
    assert.deepEqual(parsed.preMatch, record.preMatch);
    assert.deepEqual(parsed.engineOutput.probabilities, { team1: 40, draw: 30, team2: 30 });
  });

  test('persistGoldRecord failure does not throw', async () => {
    const { persistGoldRecord } = await import('../src/lib/gold-record');
    const badRecord = { id: 'x' } as any;
    assert.doesNotThrow(() => persistGoldRecord(badRecord, tempDir));
  });

  test('multiple records append correctly', async () => {
    const { persistGoldRecord } = await import('../src/lib/gold-record');
    const base: GoldRecord = {
      id: 'r1',
      generatedAt: '2026-10-05T12:00:00.000Z',
      preMatchDataCutoff: '2026-10-05T12:00:00.000Z',
      team1: 'A',
      team2: 'B',
      matchDate: null,
      competition: null,
      preMatch: {
        team1: { teamName: 'A', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
        team2: { teamName: 'B', matches: [], form: { wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, resultSequence: [] } },
        h2h: [],
        currentVenue: 'HOME',
      },
      engineOutput: { probabilities: { team1: 50, draw: 25, team2: 25 }, trace: {} as any },
      actual: null,
    };

    persistGoldRecord({ ...base, id: 'r1' }, tempDir);
    persistGoldRecord({ ...base, id: 'r2' }, tempDir);

    const filePath = join(tempDir, 'data', 'historical', 'gold-records.jsonl');
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, 'r1');
    assert.equal(JSON.parse(lines[1]).id, 'r2');
  });
});

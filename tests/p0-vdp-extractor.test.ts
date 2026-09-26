// P0-регрессионные тесты VDP Extractor (часть Test 6) — текущее поведение.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractVDP } from '../src/lib/vdp-extractor';
import { buildFullVdp, buildResearchReportWithVdp } from './helpers/fixtures';

describe('P0 VDP Extractor (current behavior)', () => {
  test('EX1: report with VERIFIED DATA PACK marker — extracts from marker to end', () => {
    const report = buildResearchReportWithVdp(buildFullVdp());
    const extracted = extractVDP(report);
    assert.ok(extracted.length > 0);
    assert.ok(extracted.startsWith('VERIFIED DATA PACK'));
    assert.ok(extracted.includes('## MATCH'));
    assert.ok(extracted.includes('## TEAM 1 FORM'));
    assert.ok(extracted.includes('Team A vs Team B'));
  });

  test('EX2: report without marker — empty string, no crash', () => {
    assert.equal(extractVDP('No verified data pack marker in this text.'), '');
    assert.equal(extractVDP(''), '');
  });
});

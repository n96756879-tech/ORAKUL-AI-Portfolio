import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTeamForVerification,
  extractTeamsFromMatchInput,
  verifyMatchTeams,
  MATCH_UNVERIFIED_ERROR,
} from '../src/lib/match-verification';

describe('normalizeTeamForVerification', () => {
  test('strips suffixes and normalizes case/punctuation', () => {
    assert.equal(normalizeTeamForVerification('FC Barcelona'), 'barcelona');
    assert.equal(normalizeTeamForVerification('«Спартак» Москва'), 'спартак москва');
    assert.equal(normalizeTeamForVerification('  Real   Madrid  CF '), 'real madrid');
  });

  test('returns empty string for null/empty input', () => {
    assert.equal(normalizeTeamForVerification(null), '');
    assert.equal(normalizeTeamForVerification(''), '');
    assert.equal(normalizeTeamForVerification('   '), '');
  });
});

describe('extractTeamsFromMatchInput', () => {
  test('parses dash/vs separators', () => {
    assert.deepEqual(extractTeamsFromMatchInput('Россия — Португалия'), ['Россия', 'Португалия']);
    assert.deepEqual(extractTeamsFromMatchInput('Team A vs Team B'), ['Team A', 'Team B']);
    assert.deepEqual(extractTeamsFromMatchInput('Alpha - Beta'), ['Alpha', 'Beta']);
  });

  test('returns null for single-team or empty input', () => {
    assert.equal(extractTeamsFromMatchInput('Barcelona'), null);
    assert.equal(extractTeamsFromMatchInput(''), null);
    assert.equal(extractTeamsFromMatchInput('   '), null);
  });
});

describe('verifyMatchTeams', () => {
  test('passes when teams match exactly (normalized)', () => {
    const result = verifyMatchTeams('Россия — Португалия', 'Россия', 'Португалия');
    assert.deepEqual(result, { ok: true });
  });

  test('passes with FC/suffix variations', () => {
    const result = verifyMatchTeams('Barcelona vs Real Madrid', 'FC Barcelona', 'Real Madrid CF');
    assert.deepEqual(result, { ok: true });
  });

  test('fails with teams_mismatch when order differs', () => {
    const result = verifyMatchTeams('Россия — Португалия', 'Португалия', 'Россия');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('fails with teams_mismatch for fictional/wrong teams', () => {
    const result = verifyMatchTeams('Россия — Португалия', 'Fantasy FC', 'Imaginary United');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('fails with vdp_teams_missing when VDP has no teams', () => {
    const result = verifyMatchTeams('Team A vs Team B', null, null);
    assert.deepEqual(result, { ok: false, reason: 'vdp_teams_missing' });
  });

  test('fails with input_unparsable for non-pair input', () => {
    const result = verifyMatchTeams('Just One Team', 'Team A', 'Team B');
    assert.deepEqual(result, { ok: false, reason: 'input_unparsable' });
  });

  test('passes cross-language alias: Венеция ↔ Venezia', () => {
    const result = verifyMatchTeams('Венеция — Интер', 'Venezia FC', 'Inter Milan');
    assert.deepEqual(result, { ok: true });
  });

  test('passes cross-language alias: Интер ↔ Internazionale Milano', () => {
    const result = verifyMatchTeams('Интер — Милан', 'FC Internazionale Milano', 'AC Milan');
    assert.deepEqual(result, { ok: true });
  });

  test('passes cross-language alias: Барселона ↔ Barcelona', () => {
    const result = verifyMatchTeams('Барселона — Реал Мадрид', 'FC Barcelona', 'Real Madrid CF');
    assert.deepEqual(result, { ok: true });
  });

  test('passes cross-language alias: Бавария Мюнхен ↔ Bayern Munich', () => {
    const result = verifyMatchTeams('Бавария Мюнхен — Боруссия Дортмунд', 'Bayern Munich', 'Borussia Dortmund');
    assert.deepEqual(result, { ok: true });
  });

  test('passes production case: бавария vs магдебург ↔ Bayern München, 1. FC Magdeburg', () => {
    const result = verifyMatchTeams('бавария vs магдебург', 'Bayern München', '1. FC Magdeburg');
    assert.deepEqual(result, { ok: true });
  });

  test('passes short RU alias with umlaut VDP form: Бавария ↔ Bayern München', () => {
    const result = verifyMatchTeams('Бавария — Боруссия Дортмунд', 'Bayern München', 'Borussia Dortmund');
    assert.deepEqual(result, { ok: true });
  });

  test('rejects swapped order for aliases with numeric prefix', () => {
    const result = verifyMatchTeams('бавария vs магдебург', '1. FC Magdeburg', 'Bayern München');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('rejects Bayern München vs Bayer Leverkusen as teams_mismatch', () => {
    const result = verifyMatchTeams('бавария vs магдебург', 'Bayern München', 'Bayer Leverkusen');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('fails when teams are genuinely different despite aliases', () => {
    const result = verifyMatchTeams('Венеция — Интер', 'Napoli', 'Juventus');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('fails when order is swapped even with aliases', () => {
    const result = verifyMatchTeams('Венеция — Интер', 'Inter Milan', 'Venezia FC');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });

  test('fails when one team matches but other does not', () => {
    const result = verifyMatchTeams('Венеция — Интер', 'Venezia FC', 'Juventus');
    assert.deepEqual(result, { ok: false, reason: 'teams_mismatch' });
  });
});

test('MATCH_UNVERIFIED_ERROR is a user-facing Russian message', () => {
  assert.ok(MATCH_UNVERIFIED_ERROR.length > 10);
  assert.match(MATCH_UNVERIFIED_ERROR, /матч/i);
});

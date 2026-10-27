import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRecoverySession,
  getRecoverySentAt,
  RECOVERY_SESSION_MAX_AGE_MS,
} from '../src/lib/auth/recovery';

function userWith(recovery: string | null | undefined) {
  return {
    id: 'u1',
    email: 'a@b.co',
    recovery_sent_at: recovery,
  } as any;
}

describe('recovery session helper', () => {
  test('returns false for null user', () => {
    assert.equal(isRecoverySession(null), false);
  });

  test('returns false when recovery_sent_at is missing or empty', () => {
    assert.equal(isRecoverySession(userWith(null)), false);
    assert.equal(isRecoverySession(userWith(undefined)), false);
    assert.equal(isRecoverySession(userWith('')), false);
  });

  test('returns false for invalid date strings', () => {
    assert.equal(isRecoverySession(userWith('not-a-date')), false);
  });

  test('returns true for a fresh recovery timestamp', () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    assert.equal(isRecoverySession(userWith(recent), now), true);
  });

  test('returns false once the recovery window expires', () => {
    const now = Date.now();
    const expired = new Date(
      now - RECOVERY_SESSION_MAX_AGE_MS - 1000,
    ).toISOString();
    assert.equal(isRecoverySession(userWith(expired), now), false);
  });

  test('getRecoverySentAt normalizes values', () => {
    assert.equal(getRecoverySentAt(null), null);
    assert.equal(getRecoverySentAt(userWith('  ')), null);
    assert.equal(
      getRecoverySentAt(userWith('2026-10-27T00:00:00Z')),
      '2026-10-27T00:00:00Z',
    );
  });
});

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAdminUser,
  parseAdminEmails,
  normalizeEmail,
  isAdminEmail,
  MAX_GRANT_AMOUNT,
  MAX_REASON_LENGTH,
} from '../src/lib/admin/guard';

describe('admin guard helpers', () => {
  test('normalizeEmail trims and lowercases', () => {
    assert.equal(normalizeEmail('  Admin@Example.COM  '), 'admin@example.com');
    assert.equal(normalizeEmail(null), '');
    assert.equal(normalizeEmail(undefined), '');
  });

  test('parseAdminEmails splits, trims, lowercases, filters invalid', () => {
    assert.deepEqual(parseAdminEmails('Admin@A.com , bob@b.com'), ['admin@a.com', 'bob@b.com']);
    assert.deepEqual(parseAdminEmails('  , , '), []);
    assert.deepEqual(parseAdminEmails('notanemail, valid@x.com'), ['valid@x.com']);
    assert.deepEqual(parseAdminEmails(undefined), []);
    assert.deepEqual(parseAdminEmails(''), []);
  });

  test('isAdminEmail normalizes before comparison', () => {
    assert.ok(isAdminEmail('ADMIN@a.com', ['admin@a.com']));
    assert.ok(!isAdminEmail('other@a.com', ['admin@a.com']));
  });

  test('MAX_GRANT_AMOUNT and MAX_REASON_LENGTH constants', () => {
    assert.equal(MAX_GRANT_AMOUNT, 100000);
    assert.equal(MAX_REASON_LENGTH, 500);
  });
});

describe('checkAdminUser', () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (originalAdminEmails !== undefined) {
      process.env.ADMIN_EMAILS = originalAdminEmails;
    } else {
      delete process.env.ADMIN_EMAILS;
    }
  });

  test('rejects null user with 401', () => {
    const r = checkAdminUser(null);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.equal(r.reason, 'no_session');
    }
  });

  test('rejects user without email with 403', () => {
    const r = checkAdminUser({ id: 'u1', email: null, email_confirmed_at: '2026-01-01' } as any);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  test('rejects unconfirmed user with 403', () => {
    process.env.ADMIN_EMAILS = 'admin@test.com';
    const r = checkAdminUser({
      id: 'u1',
      email: 'admin@test.com',
      email_confirmed_at: null,
    } as any);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 403);
      assert.equal(r.reason, 'email_not_confirmed');
    }
  });

  test('fail-closed when ADMIN_EMAILS is missing', () => {
    delete process.env.ADMIN_EMAILS;
    const r = checkAdminUser({
      id: 'u1',
      email: 'admin@test.com',
      email_confirmed_at: '2026-01-01',
    } as any);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 403);
      assert.equal(r.reason, 'admin_emails_not_configured');
    }
  });

  test('fail-closed when ADMIN_EMAILS is empty string', () => {
    process.env.ADMIN_EMAILS = '';
    const r = checkAdminUser({
      id: 'u1',
      email: 'admin@test.com',
      email_confirmed_at: '2026-01-01',
    } as any);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 403);
  });

  test('rejects confirmed user not in allowlist', () => {
    process.env.ADMIN_EMAILS = 'admin@test.com';
    const r = checkAdminUser({
      id: 'u2',
      email: 'other@test.com',
      email_confirmed_at: '2026-01-01',
    } as any);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 403);
      assert.equal(r.reason, 'not_admin');
    }
  });

  test('accepts confirmed user in allowlist (case-insensitive)', () => {
    process.env.ADMIN_EMAILS = 'Admin@Test.com';
    const r = checkAdminUser({
      id: 'u3',
      email: 'admin@test.com',
      email_confirmed_at: '2026-01-01',
    } as any);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.user.email, 'admin@test.com');
      assert.equal(r.user.id, 'u3');
    }
  });

  test('email from user object is normalized before allowlist comparison', () => {
    process.env.ADMIN_EMAILS = 'admin@test.com';
    const r = checkAdminUser({
      id: 'u3',
      email: '  Admin@Test.com  ',
      email_confirmed_at: '2026-01-01',
    } as any);
    assert.equal(r.ok, true);
  });
});

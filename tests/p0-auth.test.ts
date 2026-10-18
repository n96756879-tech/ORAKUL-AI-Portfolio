import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateEmail,
  validatePassword,
  validateAuthForm,
  PASSWORD_MIN_LENGTH,
} from '../src/lib/auth/validation';
import { mapAuthError, AUTH_UNEXPECTED_ERROR } from '../src/lib/supabase/auth-errors';
import {
  buildAuthCallbackUrl,
  resolveSiteOrigin,
  isExistingUserError,
  isUnknownUserError,
  AUTH_CALLBACK_PATH,
} from '../src/lib/auth/server';
import {
  resolveAuthRequiredAudience,
  AUTH_REQUIRED_MESSAGES,
} from '../src/lib/auth/auth-required';

describe('auth validation', () => {
  test('email: empty / malformed / valid', () => {
    assert.match(validateEmail('') ?? '', /Введите email/);
    assert.match(validateEmail('   ') ?? '', /Введите email/);
    assert.match(validateEmail('nope') ?? '', /корректный email/);
    assert.match(validateEmail('a@b') ?? '', /корректный email/);
    assert.equal(validateEmail('name@example.com'), null);
  });

  test('email: too long rejected', () => {
    const long = 'a'.repeat(250) + '@example.com';
    assert.match(validateEmail(long) ?? '', /слишком длинный/);
  });

  test('password: empty / short / long / ok', () => {
    assert.match(validatePassword('') ?? '', /Введите пароль/);
    assert.match(validatePassword('1234567') ?? '', /не менее 8/);
    assert.match(validatePassword('x'.repeat(73)) ?? '', /слишком длинный/);
    assert.equal(validatePassword('12345678'), null);
    assert.equal(PASSWORD_MIN_LENGTH, 8);
  });

  test('validateAuthForm normalizes email to lowercase and trims', () => {
    const res = validateAuthForm('  Name@Example.COM  ', 'password123');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.email, 'name@example.com');
      assert.equal(res.password, 'password123');
    }
  });

  test('validateAuthForm reports first error for invalid input', () => {
    const res = validateAuthForm('bad', 'password123');
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /корректный email/);
  });
});

describe('auth error mapping', () => {
  test('known codes map to Russian messages', () => {
    assert.match(mapAuthError('email_exists', '', 'signup'), /уже существует/);
    assert.match(mapAuthError('invalid_credentials', '', 'login'), /Неверный email/);
    assert.match(mapAuthError('email_not_confirmed', '', 'login'), /не подтверждён/);
    assert.match(mapAuthError('weak_password', '', 'signup'), /Слишком простой пароль/);
    assert.match(mapAuthError('over_email_send_rate_limit', '', 'signup'), /Слишком много писем/);
  });

  test('message fallback when code unknown', () => {
    assert.match(mapAuthError(undefined, 'Invalid login credentials', 'login'), /Неверный email/);
    assert.match(mapAuthError(undefined, 'User already registered', 'signup'), /уже существует/);
    assert.match(mapAuthError(undefined, 'Failed to fetch', 'login'), new RegExp(AUTH_UNEXPECTED_ERROR.slice(0, 20)));
  });

  test('unknown error falls back to action-specific message', () => {
    assert.match(mapAuthError(undefined, 'weird thing', 'signup'), /Не удалось создать аккаунт/);
    assert.match(mapAuthError(undefined, 'weird thing', 'login'), /Не удалось выполнить вход/);
  });
});

describe('auth server helpers', () => {
  test('buildAuthCallbackUrl appends canonical path', () => {
    assert.equal(buildAuthCallbackUrl('https://orakul.ai'), `https://orakul.ai${AUTH_CALLBACK_PATH}`);
  });

  test('resolveSiteOrigin prefers x-forwarded headers', () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      const req = new Request('http://internal', {
        headers: { 'x-forwarded-host': 'orakul.ai', 'x-forwarded-proto': 'https' },
      });
      const origin = resolveSiteOrigin(req);
      assert.equal(origin.ok, true);
      if (origin.ok) assert.equal(origin.origin, 'https://orakul.ai');
    } finally {
      if (saved !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved;
    }
  });

  test('resolveSiteOrigin falls back to Host header', () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    try {
      const req = new Request('http://internal', { headers: { host: 'example.test' } });
      const origin = resolveSiteOrigin(req);
      assert.equal(origin.ok, true);
      if (origin.ok) assert.equal(origin.origin, 'http://example.test');
    } finally {
      if (saved !== undefined) process.env.NEXT_PUBLIC_SITE_URL = saved;
    }
  });

  test('resolveSiteOrigin rejects malformed configured site url', () => {
    const saved = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'not-a-url';
    try {
      const req = new Request('http://internal', { headers: { host: 'example.test' } });
      const origin = resolveSiteOrigin(req);
      assert.equal(origin.ok, false);
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = saved;
    }
  });

  test('isExistingUserError detects common shapes', () => {
    assert.equal(isExistingUserError({ code: 'user_already_exists' }), true);
    assert.equal(isExistingUserError({ message: 'User already registered' }), true);
    assert.equal(isExistingUserError({ code: 'weak_password' }), false);
    assert.equal(isExistingUserError(null), false);
  });

  test('isUnknownUserError detects invalid credentials', () => {
    assert.equal(isUnknownUserError({ code: 'invalid_credentials' }), true);
    assert.equal(isUnknownUserError({ message: 'User not found' }), true);
    assert.equal(isUnknownUserError({ code: 'other' }), false);
  });
});

describe('auth_required banner audience', () => {
  test('resolveAuthRequiredAudience returns anonymous for null/undefined/empty', () => {
    assert.equal(resolveAuthRequiredAudience(null), 'anonymous');
    assert.equal(resolveAuthRequiredAudience(undefined), 'anonymous');
    assert.equal(resolveAuthRequiredAudience(''), 'anonymous');
    assert.equal(resolveAuthRequiredAudience('  '), 'anonymous');
  });

  test('resolveAuthRequiredAudience returns authenticated for non-empty email', () => {
    assert.equal(resolveAuthRequiredAudience('user@example.com'), 'authenticated');
  });

  test('authenticated user sees honest message', () => {
    assert.match(AUTH_REQUIRED_MESSAGES.authenticated, /Бесплатная попытка для вашего устройства уже использована/);
  });

  test('anonymous user keeps sign-up / sign-in prompt', () => {
    assert.match(AUTH_REQUIRED_MESSAGES.anonymous, /Зарегистрируйтесь или войдите/);
  });
});

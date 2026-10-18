export type AuthAction = 'signup' | 'login';

export type AuthErrorResponse = {
  error: string;
  code?: string;
};

const RUSSIAN_ERRORS: Record<string, string> = {
  email_exists:
    'Аккаунт с таким email уже существует. Войдите или восстановите пароль.',
  user_already_exists:
    'Аккаунт с таким email уже существует. Войдите или восстановите пароль.',
  invalid_credentials:
    'Неверный email или пароль. Проверьте данные и попробуйте снова.',
  email_not_confirmed:
    'Email не подтверждён. Откройте письмо от ORAKUL AI и перейдите по ссылке, затем войдите снова.',
  weak_password:
    'Слишком простой пароль. Используйте не менее 8 символов, буквы и цифры.',
  same_password:
    'Новый пароль должен отличаться от текущего.',
  signup_disabled:
    'Регистрация временно недоступна. Попробуйте позже.',
  email_provider_disabled:
    'Вход по email временно недоступен. Попробуйте позже.',
  over_email_send_rate_limit:
    'Слишком много писем на этот адрес. Подождите несколько минут и повторите.',
  over_request_rate_limit:
    'Слишком много попыток. Подождите минуту и повторите.',
  email_address_invalid: 'Проверьте адрес email — он выглядит некорректно.',
  validation_failed: 'Проверьте корректность email и пароля.',
};

export const AUTH_UNEXPECTED_ERROR =
  'Не удалось выполнить запрос. Проверьте соединение и попробуйте снова.';

export function mapAuthError(
  code: string | undefined,
  message: string | undefined,
  action: AuthAction,
): string {
  if (code && RUSSIAN_ERRORS[code]) {
    return RUSSIAN_ERRORS[code];
  }

  const msg = (message || '').toLowerCase();
  if (msg.includes('already registered') || msg.includes('already exists')) {
    return RUSSIAN_ERRORS.email_exists;
  }
  if (msg.includes('invalid login credentials')) {
    return RUSSIAN_ERRORS.invalid_credentials;
  }
  if (msg.includes('email not confirmed')) {
    return RUSSIAN_ERRORS.email_not_confirmed;
  }
  if (msg.includes('password should be') || msg.includes('weak password')) {
    return RUSSIAN_ERRORS.weak_password;
  }
  if (msg.includes('rate limit') || msg.includes('too many')) {
    return RUSSIAN_ERRORS.over_request_rate_limit;
  }
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('failed to fetch')) {
    return AUTH_UNEXPECTED_ERROR;
  }

  if (action === 'signup') {
    return 'Не удалось создать аккаунт. Проверьте данные и попробуйте снова.';
  }
  return 'Не удалось выполнить вход. Проверьте данные и попробуйте снова.';
}

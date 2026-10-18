export const PASSWORD_MIN_LENGTH = 8;

export type AuthFormValidation =
  | { ok: true; email: string; password: string }
  | { ok: false; error: string };

export function validateEmail(emailRaw: string): string | null {
  const email = emailRaw.trim();
  if (!email) return 'Введите email.';
  if (email.length > 254) return 'Email слишком длинный.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return 'Введите корректный email, например name@example.com.';
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Введите пароль.';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Пароль должен содержать не менее ${PASSWORD_MIN_LENGTH} символов.`;
  }
  if (password.length > 72) return 'Пароль слишком длинный (максимум 72 символа).';
  return null;
}

export function validateAuthForm(emailRaw: string, password: string): AuthFormValidation {
  const emailError = validateEmail(emailRaw);
  if (emailError) return { ok: false, error: emailError };
  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, error: passwordError };
  return { ok: true, email: emailRaw.trim().toLowerCase(), password };
}

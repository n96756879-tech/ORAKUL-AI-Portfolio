export type AuthRequiredAudience = 'anonymous' | 'authenticated';

export function resolveAuthRequiredAudience(
  authEmail: string | null | undefined,
): AuthRequiredAudience {
  return typeof authEmail === 'string' && authEmail.trim().length > 0
    ? 'authenticated'
    : 'anonymous';
}

export const AUTH_REQUIRED_MESSAGES: Record<AuthRequiredAudience, string> = {
  anonymous:
    'Бесплатный лимит анализов исчерпан. Зарегистрируйтесь или войдите, чтобы продолжить.',
  authenticated:
    'Бесплатная попытка для вашего устройства уже использована. Дополнительные генерации на уровне аккаунта пока недоступны.',
};

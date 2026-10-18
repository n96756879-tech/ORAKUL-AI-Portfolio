'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { validateAuthForm, PASSWORD_MIN_LENGTH } from '@/lib/auth/validation';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const validation = validateAuthForm(email, password);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: validation.email, password: validation.password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Не удалось создать аккаунт.');
        return;
      }

      if (data.status === 'confirmation_required') {
        setSuccess(data.message || 'Аккаунт создан. Проверьте почту для подтверждения email.');
      }
    } catch {
      setError('Сбой связи с сервером. Попробуйте снова.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white">Регистрация в ORAKUL AI</h1>
          <p className="text-slate-400 text-sm mt-2">
            Создайте аккаунт, чтобы продолжить использование сервиса.
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {success ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-500/10 border border-green-500/30 px-4 py-3 text-sm text-green-300">
              {success}
            </div>
            <Link
              href="/auth/login"
              className="block text-center text-cyan-400 hover:text-cyan-300 text-sm"
            >
              Перейти ко входу
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                placeholder="name@example.com"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">
                Пароль (мин. {PASSWORD_MIN_LENGTH} символов)
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                placeholder="••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full px-6 py-3 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-slate-500">
          Уже есть аккаунт?{' '}
          <Link href="/auth/login" className="text-cyan-400 hover:text-cyan-300">
            Войти
          </Link>
        </p>
      </div>
    </main>
  );
}

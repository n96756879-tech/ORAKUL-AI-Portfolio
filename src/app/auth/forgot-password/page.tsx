'use client';

import { useState } from 'react';
import Link from 'next/link';
import { validateEmail } from '@/lib/auth/validation';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSuccess(false);

    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setError(
          typeof data?.error === 'string'
            ? data.error
            : 'Не удалось отправить письмо.',
        );
        return;
      }
      setSuccess(true);
    } catch {
      setError('Сбой связи с сервером. Попробуйте снова.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-white">Восстановление пароля</h1>
          <p className="text-sm text-slate-400">
            Введите email, привязанный к аккаунту. Мы отправим ссылку для смены пароля.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-xs font-mono tracking-wider text-slate-400 uppercase mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {success && (
            <p className="text-sm text-emerald-400">
              Если аккаунт существует, письмо отправлено. Проверьте почту.
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? 'Отправка…' : 'Отправить ссылку'}
          </button>
        </form>
        <div className="text-center">
          <Link href="/auth/login" className="text-sm text-slate-400 hover:text-cyan-400 transition-colors">
            Вернуться ко входу
          </Link>
        </div>
      </div>
    </main>
  );
}

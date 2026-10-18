'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { validateAuthForm } from '@/lib/auth/validation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validation = validateAuthForm(email, password);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: validation.email, password: validation.password }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Не удалось выполнить вход.');
        return;
      }

      const redirectTo = searchParams.get('redirectedFrom') || '/';
      router.push(redirectTo);
      router.refresh();
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
          <h1 className="text-2xl font-bold text-white">Вход в ORAKUL AI</h1>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

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
            <label className="block text-sm text-slate-400 mb-1">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-4 py-3 rounded-lg bg-slate-900 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-6 py-3 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors disabled:opacity-50"
          >
            {submitting ? 'Выполняем вход…' : 'Войти'}
          </button>
        </form>

        <p className="text-center text-sm text-slate-500">
          Нет аккаунта?{' '}
          <Link href="/auth/signup" className="text-cyan-400 hover:text-cyan-300">
            Зарегистрироваться
          </Link>
        </p>
      </div>
    </main>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { validatePassword, PASSWORD_MIN_LENGTH } from '@/lib/auth/validation';

export function ResetPasswordForm() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const pwError = validatePassword(newPassword);
    if (pwError) {
      setError(pwError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Пароли не совпадают.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword, confirmPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.status !== 'ok') {
        setError(
          typeof data?.error === 'string'
            ? data.error
            : 'Не удалось сменить пароль.',
        );
        return;
      }
      router.push('/auth/login?reset=success');
    } catch {
      setError('Сбой связи с сервером. Попробуйте снова.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="reset-new-password" className="block text-xs font-mono tracking-wider text-slate-400 uppercase mb-1">
          Новый пароль
        </label>
        <input
          id="reset-new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={72}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={submitting}
          className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
      </div>
      <div>
        <label htmlFor="reset-confirm-password" className="block text-xs font-mono tracking-wider text-slate-400 uppercase mb-1">
          Подтвердите пароль
        </label>
        <input
          id="reset-confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={72}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={submitting}
          className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-400 disabled:opacity-50"
      >
        {submitting ? 'Сохранение…' : 'Сменить пароль'}
      </button>
    </form>
  );
}

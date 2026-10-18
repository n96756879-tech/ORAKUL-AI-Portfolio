'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

function ConfirmContent() {
  const searchParams = useSearchParams();
  const status = searchParams.get('status');

  if (status === 'error') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
        <div className="max-w-md w-full text-center space-y-4">
          <h1 className="text-2xl font-bold text-white">
            Не удалось подтвердить email
          </h1>
          <p className="text-slate-400">
            Ссылка подтверждения недействительна или истекла. Попробуйте зарегистрироваться снова или запросить новое письмо.
          </p>
          <Link
            href="/auth/signup"
            className="inline-block px-6 py-3 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors"
          >
            Зарегистрироваться
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-2xl font-bold text-white">
          Email подтверждён
        </h1>
        <p className="text-slate-400">
          Ваш аккаунт активирован. Теперь вы можете войти и продолжить использование ORAKUL AI.
        </p>
        <Link
          href="/auth/login"
          className="inline-block px-6 py-3 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors"
        >
          Войти
        </Link>
      </div>
    </main>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmContent />
    </Suspense>
  );
}

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  let supabase;
  try {
    supabase = await createClient();
  } catch {
    redirect('/auth/login?redirectedFrom=/dashboard');
  }

  const session = await getCurrentSession(supabase);
  if (!session.ok || !session.user) {
    redirect('/auth/login?redirectedFrom=/dashboard');
  }

  const email = session.user.email ?? '—';
  const emailConfirmedAt = session.user.email_confirmed_at ?? null;
  const emailConfirmed = !!emailConfirmedAt;

  return (
    <main className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col items-center justify-start p-4 sm:p-6 lg:p-12 relative overflow-x-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-gradient-to-b from-cyan-900/10 via-indigo-950/10 to-transparent blur-3xl pointer-events-none -z-10" />

      <div className="w-full max-w-3xl flex flex-col items-center pt-8 sm:pt-16 pb-16">
        <header className="text-center mb-10 w-full">
          <div className="flex justify-end w-full mb-2">
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <Link href="/dashboard" className="text-cyan-400 hover:text-cyan-300">
                Личный кабинет
              </Link>
              <Link href="/" className="text-slate-400 hover:text-cyan-300">
                На главную
              </Link>
              <form action="/api/auth/logout" method="POST">
                <button
                  type="submit"
                  className="text-cyan-400 hover:text-cyan-300"
                >
                  Выйти
                </button>
              </form>
            </div>
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
            Личный кабинет
          </h1>
        </header>

        <section className="w-full space-y-6">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-xl px-6 py-5">
            <dl className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <dt className="text-xs font-mono tracking-wider text-slate-400 uppercase">
                  Email
                </dt>
                <dd className="text-sm sm:text-base text-slate-100 font-medium">
                  {email}
                </dd>
              </div>
              <div className="border-t border-slate-800/80 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <dt className="text-xs font-mono tracking-wider text-slate-400 uppercase">
                  Подтверждение email
                </dt>
                <dd className="text-sm">
                  {emailConfirmed ? (
                    <span className="text-green-400">Подтверждён</span>
                  ) : (
                    <span className="text-amber-400">Не подтверждён</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-xl px-6 py-5">
            <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-3">
              Мои анализы
            </h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              История ваших анализов будет доступна здесь после реализации хранения на уровне аккаунта.
            </p>
          </div>

          <div className="text-center">
            <Link
              href="/"
              className="inline-block px-6 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-sm transition-all shadow-lg shadow-cyan-500/20"
            >
              Перейти к анализу
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

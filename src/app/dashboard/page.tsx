import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentSession } from '@/lib/auth/session';
import { createServiceRoleClient } from '@/lib/supabase/admin';
import { getBalance } from '@/lib/supabase/credits';
import { listPredictions } from '@/lib/supabase/predictions';
import type { PredictionRow } from '@/lib/supabase/predictions';

const ANALYSIS_COST = Number(process.env.ANALYSIS_COST || '0');

const HISTORY_LIMIT = 20;

type HistoryItem = {
  id: string;
  matchTitle: string;
  createdAt: string;
  outcomes: Array<{ label: string; value: string }>;
  details: string[];
};

function readHistoryItem(row: PredictionRow): HistoryItem {
  const payload = (row.payload ?? {}) as Record<string, any>;
  const probabilities = (payload.probabilities ?? {}) as Record<string, any>;

  const outcomes = Array.isArray(probabilities.outcomes)
    ? probabilities.outcomes
        .filter((item: any) => item && typeof item.label === 'string' && typeof item.value === 'string')
        .map((item: any) => ({ label: String(item.label), value: String(item.value) }))
    : [];

  const details: string[] = [];
  const meta = payload.match && typeof payload.match.meta === 'string' ? payload.match.meta : null;
  if (meta) details.push(meta);

  if (Array.isArray(probabilities.totals)) {
    const totals = probabilities.totals
      .filter((item: any) => item && typeof item.label === 'string' && typeof item.value === 'string')
      .map((item: any) => `${item.label} ${item.value}`);
    if (totals.length > 0) details.push(totals.join(' · '));
  }

  if (Array.isArray(probabilities.btts)) {
    const btts = probabilities.btts
      .filter((item: any) => item && typeof item.label === 'string' && typeof item.value === 'string')
      .map((item: any) => `Обе забьют: ${item.label} ${item.value}`);
    if (btts.length > 0) details.push(btts.join(' · '));
  }

  return {
    id: row.id,
    matchTitle: row.match_title,
    createdAt: row.created_at,
    outcomes,
    details,
  };
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

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

  const userId = session.user.id;
  let credits = 0;
  let creditsError = false;
  let history: HistoryItem[] = [];
  let historyError = false;
  try {
    const adminClient = createServiceRoleClient();
    const bal = await getBalance(adminClient, userId);
    if (bal.ok) {
      credits = bal.balance;
    } else {
      creditsError = true;
    }
  } catch {
    creditsError = true;
  }

  try {
    const adminClient = createServiceRoleClient();
    const historyResult = await listPredictions(adminClient, userId, HISTORY_LIMIT);
    if (historyResult.ok) {
      history = historyResult.predictions
        .filter((row) => row.user_id === userId)
        .map(readHistoryItem);
    } else {
      historyError = true;
    }
  } catch {
    historyError = true;
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
              <div className="border-t border-slate-800/80 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <dt className="text-xs font-mono tracking-wider text-slate-400 uppercase">
                  Кредиты
                </dt>
                <dd className="text-sm font-mono">
                  {creditsError ? (
                    <span className="text-red-400">недоступно</span>
                  ) : (
                    <span className="text-cyan-400">{credits}</span>
                  )}
                </dd>
              </div>
              <div className="border-t border-slate-800/80 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <dt className="text-xs font-mono tracking-wider text-slate-400 uppercase">
                  Стоимость анализа
                </dt>
                <dd className="text-sm font-mono">
                  {ANALYSIS_COST > 0 ? (
                    <span className="text-amber-400">{ANALYSIS_COST}</span>
                  ) : (
                    <span className="text-red-400">не настроено</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 backdrop-blur-xl px-6 py-5">
            <h2 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-3">
              Мои анализы
            </h2>
            {historyError ? (
              <p className="text-sm text-red-400 leading-relaxed">
                История прогнозов недоступна. Попробуйте обновить страницу позже.
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-slate-400 leading-relaxed">
                У вас пока нет сохранённых прогнозов.
              </p>
            ) : (
              <ul className="space-y-4">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="border-t border-slate-800/80 pt-4 first:border-t-0 first:pt-0"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
                      <span className="text-sm sm:text-base text-slate-100 font-medium">
                        {item.matchTitle}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        {formatCreatedAt(item.createdAt)}
                      </span>
                    </div>
                    {item.outcomes.length > 0 && (
                      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {item.outcomes.map((outcome) => (
                          <div key={outcome.label} className="flex items-baseline gap-1">
                            <dt className="text-xs text-slate-400">{outcome.label}</dt>
                            <dd className="text-xs font-mono text-cyan-400">{outcome.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {item.details.length > 0 && (
                      <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                        {item.details.join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
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

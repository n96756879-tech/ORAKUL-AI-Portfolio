'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  resolveAuthRequiredAudience,
  AUTH_REQUIRED_MESSAGES,
} from '@/lib/auth/auth-required';

interface ProbabilityItem {
  label: string;
  value: string;
}

interface AnalysisResult {
  status: 'success' | 'insufficient_data' | 'unidentified_match';
  errorMessage?: string;
  match?: {
    title: string;
    meta?: string;
  };
  probabilities?: {
    outcomes?: ProbabilityItem[];
    totals?: ProbabilityItem[];
    btts?: ProbabilityItem[];
  };
  explanation?: {
    overview?: string;
    team1Form?: string;
    team2Form?: string;
    h2h?: string;
    squadAndInjuries?: string;
    factors?: string;
  };
  usedSources?: Array<{
    title: string;
    url: string;
  }>;
}

export default function Home() {
  const [team1Input, setTeam1Input] = useState('');
  const [team2Input, setTeam2Input] = useState('');
  const [matchDateInput, setMatchDateInput] = useState('');
  const [sport, setSport] = useState<'football' | 'hockey'>('football');
  const [loadingState, setLoadingState] = useState<'idle' | 'searching' | 'analyzing'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);

  const refreshSession = async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      const data = await res.json();
      setAuthEmail(data?.user?.email ?? null);
    } catch {
      setAuthEmail(null);
    } finally {
      setAuthChecked(true);
    }
  };

  useEffect(() => {
    void refreshSession();
  }, []);

  const handleLogout = async () => {
    setAuthBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      setAuthEmail(null);
      setAuthRequired(false);
    } catch {
      // keep current state on network failure
    } finally {
      setAuthBusy(false);
    }
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!team1Input.trim() || !team2Input.trim()) {
      return;
    }

    setResult(null);
    setErrorMsg(null);
    setAuthRequired(false);
    
    // UX генерации по ТЗ:
    // 1. 🔎 Ищем актуальные данные...
    setLoadingState('searching');

    const searchTimer = setTimeout(() => {
      // 2. 🧠 Анализируем матч...
      setLoadingState('analyzing');
    }, 2200);

    // One identifier per logical analysis: it lets the server reuse a single
    // credit reservation if this request is repeated, while separate analyses
    // (even of the same match) remain separately charged.
    const operationId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

    const hasTeam1 = team1Input.trim().length > 0;
    const hasTeam2 = team2Input.trim().length > 0;
    const payload: Record<string, unknown> = { sport, operationId };
    if (hasTeam1 || hasTeam2) {
      payload.team1 = team1Input.trim();
      payload.team2 = team2Input.trim();
    }
    if (matchDateInput.trim()) {
      payload.matchDate = matchDateInput.trim();
    }

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      clearTimeout(searchTimer);

      const data = await response.json();

      if (response.status === 402) {
        if (data.status === 'auth_required') {
          await refreshSession();
          setAuthRequired(true);
          setErrorMsg(null);
          setLoadingState('idle');
          return;
        }
        if (data.status === 'insufficient_credits') {
          setErrorMsg('Недостаточно кредитов. Пополните баланс в Личном кабинете.');
          setLoadingState('idle');
          return;
        }
        setErrorMsg('Платёжная ошибка. Попробуйте позже или проверьте баланс.');
        setLoadingState('idle');
        return;
      }

      if (!response.ok || data.error) {
        setErrorMsg(data.error || 'Произошла ошибка при анализе матча.');
        setLoadingState('idle');
        return;
      }

      if (data.status === 'unidentified_match') {
        setErrorMsg('Не удалось однозначно определить матч. Уточните команды, турнир или дату.');
        setLoadingState('idle');
        return;
      }

      if (data.status === 'insufficient_data') {
        setErrorMsg('Недостаточно актуальных данных для полноценного анализа.');
        setLoadingState('idle');
        return;
      }

      setResult(data);
      setLoadingState('idle');
    } catch (err) {
      clearTimeout(searchTimer);
      console.error('Client analyze fetch error:', err);
      setErrorMsg('Произошла сбой связи с сервером. Попробуйте еще раз.');
      setLoadingState('idle');
    }
  };

  return (
    <main className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col items-center justify-start p-4 sm:p-6 lg:p-12 relative overflow-x-hidden">
      {/* Background Subtle Gradient Effects */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-gradient-to-b from-cyan-900/10 via-indigo-950/10 to-transparent blur-3xl pointer-events-none -z-10" />

      {/* Main Container */}
      <div className="w-full max-w-3xl flex flex-col items-center pt-8 sm:pt-16 pb-16">
        {/* Header */}
        <header className="text-center mb-10">
          <div className="flex justify-end w-full mb-2">
            {authChecked && authEmail ? (
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <Link href="/dashboard" className="text-cyan-400 hover:text-cyan-300">
                  Личный кабинет
                </Link>
                <span className="text-slate-300">{authEmail}</span>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={authBusy}
                  className="text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                >
                  Выйти
                </button>
              </div>
            ) : authChecked ? (
              <div className="flex items-center gap-3 text-xs">
                <Link href="/auth/login" className="text-cyan-400 hover:text-cyan-300">
                  Войти
                </Link>
                <Link href="/auth/signup" className="text-cyan-400 hover:text-cyan-300">
                  Регистрация
                </Link>
              </div>
            ) : null}
          </div>
          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
            ORAKUL AI
          </h1>

          <p className="mt-3 text-sm sm:text-base text-slate-400 max-w-lg mx-auto leading-relaxed">
            AI-аналитик футбольных матчей на основе актуальных данных
          </p>
        </header>

        {authRequired && (
          <div className="w-full mb-6 rounded-xl border border-cyan-500/30 bg-cyan-500/5 px-5 py-4 text-center">
            {resolveAuthRequiredAudience(authEmail) === 'authenticated' ? (
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-slate-200">
                  {AUTH_REQUIRED_MESSAGES.authenticated}
                </p>
                <Link
                  href="/dashboard"
                  className="px-5 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300 transition-colors text-sm"
                >
                  Личный кабинет
                </Link>
              </div>
            ) : (
              <>
                <p className="text-sm text-slate-200 mb-3">
                  {AUTH_REQUIRED_MESSAGES.anonymous}
                </p>
                <div className="flex items-center justify-center gap-4 text-sm">
                  <Link
                    href="/auth/signup"
                    className="px-5 py-2 rounded-lg bg-cyan-500 text-white font-semibold hover:bg-cyan-400 transition-colors"
                  >
                    Зарегистрироваться
                  </Link>
                  <Link
                    href="/auth/login"
                    className="px-5 py-2 rounded-lg border border-slate-700 text-slate-300 hover:border-cyan-500 hover:text-cyan-300 transition-colors"
                  >
                    Войти
                  </Link>
                </div>
              </>
            )}
          </div>
        )}

        {/* Input Form */}
        <form onSubmit={handleAnalyze} className="w-full mb-8">
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setSport('football')}
              className={`px-4 py-1.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all ${
                sport === 'football' ? 'bg-cyan-900 border border-cyan-500 text-cyan-200' : 'bg-slate-800 border border-slate-700 text-slate-400'
              }`}
            >
              Football
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={team1Input}
              onChange={(e) => setTeam1Input(e.target.value)}
              placeholder="Команда 1"
              required
              disabled={loadingState !== 'idle'}
              className="bg-slate-900/60 text-slate-100 placeholder-slate-500 px-4 py-3 rounded-xl border border-slate-800 focus:border-cyan-500/70 focus:outline-none focus:ring-2 focus:ring-cyan-500/10 transition-all disabled:opacity-60"
            />
            <input
              type="text"
              value={team2Input}
              onChange={(e) => setTeam2Input(e.target.value)}
              placeholder="Команда 2"
              required
              disabled={loadingState !== 'idle'}
              className="bg-slate-900/60 text-slate-100 placeholder-slate-500 px-4 py-3 rounded-xl border border-slate-800 focus:border-cyan-500/70 focus:outline-none focus:ring-2 focus:ring-cyan-500/10 transition-all disabled:opacity-60"
            />
          </div>

          <div className="mt-3">
            <label htmlFor="match-date-input" className="block mb-1.5 text-xs font-mono uppercase tracking-wider text-slate-400">
              Дата матча
            </label>
            <input
              id="match-date-input"
              type="date"
              value={matchDateInput}
              onChange={(e) => setMatchDateInput(e.target.value)}
              disabled={loadingState !== 'idle'}
              className="w-full bg-slate-900/60 text-slate-100 placeholder-slate-500 px-4 py-3 rounded-xl border border-slate-800 focus:border-cyan-500/70 focus:outline-none focus:ring-2 focus:ring-cyan-500/10 transition-all disabled:opacity-60"
            />
          </div>

          <button
            type="submit"
            disabled={loadingState !== 'idle' || !team1Input.trim() || !team2Input.trim()}
            className="mt-4 w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-base px-8 py-3.5 rounded-xl shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <span>✨ Анализировать {sport === 'football' ? 'матч' : 'игру'}</span>
          </button>
        </form>

          <p className="mt-4 text-center text-xs sm:text-sm text-slate-500">
            AI самостоятельно найдёт актуальную информацию о матче и объяснит свой прогноз.
          </p>

        {/* Value Proposition — стартовое состояние без результата */}
        {loadingState === 'idle' && !result && (
          <section className="w-full mt-2 text-left">
            <h2 className="text-xl sm:text-2xl font-bold text-white leading-snug">
              За каждым прогнозом — анализ данных
            </h2>
            <p className="mt-3 text-sm text-slate-400 leading-relaxed">
              ORAKUL AI самостоятельно исследует доступные источники, собирает и систематизирует информацию о футбольных матчах, анализирует форму команд и историю встреч. На основе полученных данных сервис рассчитывает вероятности исходов и формирует собственный аналитический прогноз.
            </p>

            <h3 className="mt-6 text-base sm:text-lg font-semibold text-slate-100">
              Комплексный анализ футбольной статистики
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Статистика матчей, результаты команд, текущая форма и история личных встреч помогают составить более полную картину предстоящей игры.
            </p>

            <h3 className="mt-6 text-base sm:text-lg font-semibold text-slate-100">
              Интеллектуальная обработка
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              ORAKUL AI систематизирует доступные сведения и использует собственную модель анализа для оценки возможных исходов матча.
            </p>

            <h3 className="mt-6 text-base sm:text-lg font-semibold text-slate-100">
              Вероятности вместо догадок
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Изучайте вероятности победы хозяев, ничьей и победы гостей, а также дополнительные оценки голов и тоталов.
            </p>

            <hr className="my-6 border-slate-800" />

            <h3 className="text-base sm:text-lg font-semibold text-slate-100">
              Начните бесплатно
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Выберите футбольный матч и получите первый анализ ORAKUL AI бесплатно. Оцените статистику, вероятности исходов и аналитический прогноз.
            </p>
          </section>
        )}

        {/* Loading Indicator UX */}
        {loadingState !== 'idle' && (
          <div className="w-full bg-slate-900/60 border border-slate-800 rounded-2xl p-8 text-center flex flex-col items-center justify-center my-6 shadow-xl animate-pulse">
            <div className="w-12 h-12 rounded-full border-2 border-cyan-500/30 border-t-cyan-400 animate-spin mb-4" />
            <span className="text-cyan-400 font-medium text-lg">
              {loadingState === 'searching' && '🔎 Ищем актуальные данные...'}
              {loadingState === 'analyzing' && '🧠 Анализируем матч...'}
            </span>
            <p className="text-xs text-slate-500 mt-2">
              Собираем информацию о текущей форме, составах и очных встречах...
            </p>
            <p className="text-sm text-cyan-300/90 font-medium mt-4">
              Обычно анализ занимает 1–2 минуты
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Пожалуйста, дождитесь завершения анализа и не закрывайте страницу.
            </p>
          </div>
        )}

        {/* Error State */}
        {errorMsg && (
          <div className="w-full bg-red-950/40 border border-red-500/30 text-red-200 rounded-2xl p-5 my-6 text-center text-sm sm:text-base leading-relaxed">
            <div className="font-semibold mb-1">Внимание</div>
            <div>{errorMsg}</div>
          </div>
        )}

        {/* Analysis Result Card */}
        {result && (
          <div className="w-full bg-slate-900/90 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-8 animate-fadeIn">
            {/* 1. Секция Матч */}
            <section className="border-b border-slate-800/80 pb-6">
              <span className="text-xs font-mono tracking-widest text-cyan-400 uppercase block mb-1">
                МАТЧ
              </span>
              <h2 className="text-2xl sm:text-3xl font-bold text-white">
                {result.match?.title || `${team1Input} vs ${team2Input}`}
              </h2>
              {result.match?.meta && (
                <p className="text-xs sm:text-sm text-slate-400 mt-1">
                  {result.match.meta}
                </p>
              )}
            </section>

            {/* 2. Секция Вероятности ORAKUL */}
            {result.probabilities && (
              <section className="space-y-6">
                <div>
                  <h3 className="text-sm font-mono tracking-wider text-cyan-400 uppercase mb-4">
                    ВЕРОЯТНОСТИ ORAKUL
                  </h3>
                  
                  {/* Основной исход (П1, X, П2) */}
                  {result.probabilities.outcomes && result.probabilities.outcomes.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {result.probabilities.outcomes.map((item, idx) => (
                        <div
                          key={idx}
                          className="bg-slate-800/50 border border-slate-700/60 rounded-xl p-4 text-center hover:border-cyan-500/40 transition-all"
                        >
                          <div className="text-xs text-slate-400 font-medium mb-1">
                            {item.label}
                          </div>
                          <div className="text-2xl font-extrabold text-cyan-300">
                            {item.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Тоталы */}
                {result.probabilities.totals && result.probabilities.totals.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-400 uppercase mb-3 tracking-wider">
                      Тоталы
                    </h4>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {result.probabilities.totals.map((item, idx) => (
                        <div
                          key={idx}
                          className="bg-slate-800/30 border border-slate-800 rounded-lg p-3 text-center"
                        >
                          <span className="text-xs text-slate-400 block">{item.label}</span>
                          <span className="text-lg font-bold text-slate-100">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Обе команды забьют */}
                {result.probabilities.btts && result.probabilities.btts.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-slate-400 uppercase mb-3 tracking-wider">
                      Обе команды забьют
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      {result.probabilities.btts.map((item, idx) => (
                        <div
                          key={idx}
                          className="bg-slate-800/30 border border-slate-800 rounded-lg p-3 text-center"
                        >
                          <span className="text-xs text-slate-400 block">{item.label}</span>
                          <span className="text-lg font-bold text-slate-100">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* 3. Секция Главное — Объяснение */}
            {result.explanation && (
              <section className="border-t border-slate-800/80 pt-6 space-y-4">
                <h3 className="text-sm font-mono tracking-wider text-cyan-400 uppercase">
                  ПОЧЕМУ AI СЧИТАЕТ ТАК
                </h3>

                <div className="max-h-96 overflow-y-auto pr-2 space-y-4 text-sm sm:text-base text-slate-300 leading-relaxed">
                  {result.explanation.overview && (
                    <div className="bg-slate-800/20 p-4 rounded-xl border border-slate-800">
                      <p>{result.explanation.overview}</p>
                    </div>
                  )}

                  {result.explanation.team1Form && (
                    <div>
                      <h4 className="font-semibold text-white text-xs uppercase text-cyan-400/80 mb-1">
                        Форма первой команды
                      </h4>
                      <p>{result.explanation.team1Form}</p>
                    </div>
                  )}

                  {result.explanation.team2Form && (
                    <div>
                      <h4 className="font-semibold text-white text-xs uppercase text-cyan-400/80 mb-1">
                        Форма второй команды
                      </h4>
                      <p>{result.explanation.team2Form}</p>
                    </div>
                  )}

                  {result.explanation.h2h && (
                    <div>
                      <h4 className="font-semibold text-white text-xs uppercase text-cyan-400/80 mb-1">
                        Очные встречи (H2H)
                      </h4>
                      <p>{result.explanation.h2h}</p>
                    </div>
                  )}

                  {result.explanation.squadAndInjuries && (
                    <div>
                      <h4 className="font-semibold text-white text-xs uppercase text-cyan-400/80 mb-1">
                        Составы и травмы
                      </h4>
                      <p>{result.explanation.squadAndInjuries}</p>
                    </div>
                  )}

                  {result.explanation.factors && (
                    <div>
                      <h4 className="font-semibold text-white text-xs uppercase text-cyan-400/80 mb-1">
                        Ключевые факторы аналитика
                      </h4>
                      <p>{result.explanation.factors}</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* 4. Секция Источники */}
            {result.usedSources && result.usedSources.length > 0 && (
              <section className="border-t border-slate-800/80 pt-6">
                <h3 className="text-xs font-mono tracking-wider text-slate-400 uppercase mb-3">
                  ИСТОЧНИКИ
                </h3>

                <ul className="space-y-2">
                  {result.usedSources.map((source, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-xs sm:text-sm">
                      <span className="text-cyan-400">•</span>
                      <span className="text-slate-300 line-clamp-1">
                        {source.title || source.url}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

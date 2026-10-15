'use client';

import { useState } from 'react';

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
  const [matchInput, setMatchInput] = useState('');
  const [sport, setSport] = useState<'football' | 'hockey'>('football');
  const [loadingState, setLoadingState] = useState<'idle' | 'searching' | 'analyzing'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!matchInput.trim()) {
      return;
    }

    setResult(null);
    setErrorMsg(null);
    
    // UX генерации по ТЗ:
    // 1. 🔎 Ищем актуальные данные...
    setLoadingState('searching');

    const searchTimer = setTimeout(() => {
      // 2. 🧠 Анализируем матч...
      setLoadingState('analyzing');
    }, 2200);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ match: matchInput.trim(), sport }),
      });

      clearTimeout(searchTimer);

      const data = await response.json();

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
          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight bg-gradient-to-r from-white via-slate-200 to-cyan-400 bg-clip-text text-transparent">
            ORAKUL AI
          </h1>

          <p className="mt-3 text-sm sm:text-base text-slate-400 max-w-lg mx-auto leading-relaxed">
            AI-аналитик футбольных матчей на основе актуальных данных
          </p>
        </header>

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
          <div className="relative group">
            <input
              type="text"
              value={matchInput}
              onChange={(e) => setMatchInput(e.target.value)}
              placeholder={sport === 'football' ? "Россия — Португалия" : "Торонто — Монреаль"}
              disabled={loadingState !== 'idle'}
              className="w-full bg-slate-900/80 backdrop-blur-xl text-slate-100 placeholder-slate-500 text-lg sm:text-xl font-medium px-6 py-5 rounded-2xl border border-slate-800 focus:border-cyan-500/80 focus:outline-none focus:ring-4 focus:ring-cyan-500/10 transition-all shadow-2xl disabled:opacity-60"
            />
            
            <button
              type="submit"
              disabled={loadingState !== 'idle' || !matchInput.trim()}
              className="mt-4 w-full sm:w-auto sm:absolute sm:right-3 sm:top-3 sm:mt-0 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold text-base px-8 py-3.5 rounded-xl shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <span>✨ Анализировать {sport === 'football' ? 'матч' : 'игру'}</span>
            </button>
          </div>

          <p className="mt-4 text-center text-xs sm:text-sm text-slate-500">
            AI самостоятельно найдёт актуальную информацию о матче и объяснит свой прогноз.
          </p>
        </form>

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
                {result.match?.title || matchInput}
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

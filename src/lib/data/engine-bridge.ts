// STEP 18: Engine Bridge — безопасное заполнение отсутствующих данных ParsedVDP
// подтверждёнными записями DataPack.form ПЕРЕД Probability Engine.
//
// Приоритет источников (без двойного счёта):
//   1) валидный ParsedVDP (You.com VDP) — абсолютный приоритет, не трогаем;
//   2) подтверждённые (confirmed === true) записи DataPack.form (DAL) — только
//      для секции команды, у которой вообще нет валидных матчей;
//   3) fallback самого Probability Engine (не изменяется).
//
// Гарантии:
//   * вход НИКОГДА не мутируется — возвращается полностью новая структура;
//   * без DataPack / без confirmed-записей результат эквивалентен входу;
//   * H2H/ParsedVDP.h2h не синтезируется и не подменяется;
//   * opponentStrength/venue не выдумываются (UNKNOWN);
//   * отсутствующие поля ParsedMatch заполняются нейтральными значениями,
//     значения не фабрикуются.

import type { ParsedVDP, ParsedTeam, ParsedMatch, ParsedForm, ParsedH2H } from '../vdp-parser';
import type { DataPack, TeamFormSnapshot } from './types';

const REAL_RESULTS = new Set<ParsedMatch['result']>(['W', 'D', 'L']);

// Матч считается валидным, если в нём есть хотя бы один реальный сигнал.
function isRealMatch(match: ParsedMatch | null | undefined): boolean {
  if (!match) return false;
  if (REAL_RESULTS.has(match.result)) return true;
  if (match.goalsFor !== null && match.goalsFor !== undefined) return true;
  if (match.goalsAgainst !== null && match.goalsAgainst !== undefined) return true;
  if (match.opponent) return true;
  if (match.date) return true;
  return false;
}

function hasValidMatchSet(matches: ParsedMatch[] | null | undefined): boolean {
  return Array.isArray(matches) && matches.some(isRealMatch);
}

// Нормализация имени для сопоставления form-записи с team1/team2.
function normalizeName(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesTeam(snapshotTeam: string | null | undefined, teamName: string | null): boolean {
  if (!teamName) return false;
  const a = normalizeName(snapshotTeam);
  const b = normalizeName(teamName);
  if (!a || !b) return false;
  return a === b;
}

function cloneMatch(match: ParsedMatch): ParsedMatch {
  return { ...match };
}

function cloneTeam(team: ParsedTeam): ParsedTeam {
  return {
    teamName: team.teamName,
    matches: Array.isArray(team.matches) ? team.matches.map(cloneMatch) : [],
    form: {
      wins: team.form.wins,
      draws: team.form.draws,
      losses: team.form.losses,
      goalsFor: team.form.goalsFor,
      goalsAgainst: team.form.goalsAgainst,
      goalDifference: team.form.goalDifference,
      resultSequence: [...team.form.resultSequence],
    },
  };
}

// Запись пригодна для инъекции только если содержит реальные per-match данные
// (result/goals/opponent). Summary-only запись (форма одной строкой) не является
// матчем и не разворачивается в синтетические матчи.
function isUsableSnapshot(snapshot: TeamFormSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.result === 'W' || snapshot.result === 'D' || snapshot.result === 'L') return true;
  const gf = snapshot.goalsFor;
  const ga = snapshot.goalsAgainst;
  if (typeof gf === 'number' && typeof ga === 'number') return true;
  return Boolean(snapshot.opponent);
}

// TeamFormSnapshot → ParsedMatch: только реальные поля, остальное — нейтрально.
function snapshotToMatch(snapshot: TeamFormSnapshot): ParsedMatch {
  const goalsFor = typeof snapshot.goalsFor === 'number' ? snapshot.goalsFor : null;
  const goalsAgainst = typeof snapshot.goalsAgainst === 'number' ? snapshot.goalsAgainst : null;
  const result: ParsedMatch['result'] =
    snapshot.result === 'W' || snapshot.result === 'D' || snapshot.result === 'L'
      ? snapshot.result
      : 'UNKNOWN';
  const score = goalsFor !== null && goalsAgainst !== null ? `${goalsFor}-${goalsAgainst}` : null;

  return {
    date: snapshot.date ?? null,
    competition: null,
    opponent: snapshot.opponent ?? null,
    venue: snapshot.venue ?? 'UNKNOWN',
    score,
    goalsFor,
    goalsAgainst,
    result,
    opponentStrength: snapshot.opponentStrength ?? 'UNKNOWN',
    source: null,
    url: null,
    confidence: null,
    penaltyShootout: null,
  };
}

// Пересчёт ParsedForm по фактическому набору матчей (эквивалент computeForm
// парсера), чтобы goalDifference/draws оставались согласованы с инъекцией.
function computeForm(matches: ParsedMatch[]): ParsedForm {
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  const resultSequence: Array<'W' | 'D' | 'L'> = [];

  for (const match of matches) {
    if (match.result === 'W') {
      wins += 1;
      resultSequence.push('W');
    } else if (match.result === 'D') {
      draws += 1;
      resultSequence.push('D');
    } else if (match.result === 'L') {
      losses += 1;
      resultSequence.push('L');
    }
    if (match.goalsFor !== null) goalsFor += match.goalsFor;
    if (match.goalsAgainst !== null) goalsAgainst += match.goalsAgainst;
  }

  return {
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalDifference: goalsFor - goalsAgainst,
    resultSequence,
  };
}

// Подтверждённые form-записи DataPack, относящиеся к конкретной команде.
function confirmedFormFor(pack: DataPack | null | undefined, teamName: string | null): TeamFormSnapshot[] {
  if (!pack || !Array.isArray(pack.form)) return [];
  const snapshots: TeamFormSnapshot[] = [];
  for (const entry of pack.form) {
    if (!entry || entry.confirmed !== true) continue;
    const data = entry.data;
    if (!data || typeof data !== 'object') continue;
    if (!matchesTeam(data.team, teamName)) continue;
    if (!isUsableSnapshot(data)) continue;
    snapshots.push(data);
  }
  return snapshots;
}

function bridgeTeam(team: ParsedTeam, pack: DataPack | null | undefined): ParsedTeam {
  const cloned = cloneTeam(team);

  // Абсолютный приоритет: у команды уже есть валидные матчи → ничего не добавляем.
  if (hasValidMatchSet(team.matches)) {
    return cloned;
  }

  const snapshots = confirmedFormFor(pack, team.teamName);
  if (snapshots.length === 0) {
    // Нечего безопасно заполнить: возвращаем эквивалентную копию.
    return cloned;
  }

  const injected = snapshots.map(snapshotToMatch);
  return {
    teamName: cloned.teamName,
    matches: injected,
    form: computeForm(injected),
  };
}

function bridgeH2H(vdpH2H: ParsedVDP['h2h'], pack: DataPack | null | undefined): ParsedH2H[] {
  if (Array.isArray(vdpH2H) && vdpH2H.length > 0) {
    return vdpH2H.map((entry) => ({ ...entry }));
  }
  if (!pack || !Array.isArray(pack.h2h)) return [];
  return pack.h2h
    .filter((entry) => entry && entry.confirmed === true && entry.data)
    .map(({ data }) => ({
      date: data.date,
      competition: data.competition,
      score: data.score,
      winner: data.winner,
      source: null,
      status: null,
    }));
}

export function mergeEngineInput(vdp: ParsedVDP, pack?: DataPack | null): ParsedVDP {
  return {
    team1: bridgeTeam(vdp.team1, pack),
    team2: bridgeTeam(vdp.team2, pack),
    h2h: bridgeH2H(vdp.h2h, pack),
    currentVenue: vdp.currentVenue,
  };
}

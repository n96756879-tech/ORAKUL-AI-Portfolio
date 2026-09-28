// STEP 14: offline TeamFormSnapshot extractor (Form Snapshot Layer).
// Извлекает последние матчи команды из cleaned text (Web Fetch/Research)
// и нормализует их в существующий тип TeamFormSnapshot.
// Без HTTP, без resolver, без Probability Engine: подготовительный слой
// для будущего заполнения DataPack.form.
// Строго null-safe: нет данных в тексте → null/пропуск записи, ничего не выдумываем.

import type { TeamFormSnapshot } from './types';

// Максимум подтверждённых матчей в одном извлечении (MVP).
const MAX_MATCHES = 10;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// UI/навигационные подписи, которые никогда не являются командой.
// Только точное совпадение, чтобы не отсекать реальные названия («Liverpool»).
const NOISE_LABELS = new Set([
  'updates', 'timeline', 'stats', 'statistics', 'line-ups', 'lineups', 'lineup',
  'squad', 'squads', 'standings', 'table', 'fixtures', 'results', 'news',
  'videos', 'highlights', 'menu', 'form', 'h2h', 'preview', 'report',
]);

// Суффиксы, отбрасываемые при сопоставлении имён («England FC» → «england»).
const TEAM_SUFFIX_TOKENS = new Set(['fc', 'sc', 'cf', 'afc', 'national', 'team']);

type FormResult = 'W' | 'D' | 'L';

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&(apos|#39);/gi, "'");
}

function normalizeLine(line: string): string {
  return stripHtml(line).replace(/\s+/g, ' ').trim();
}

function isNoiseLabel(value: string): boolean {
  return NOISE_LABELS.has(value.toLowerCase());
}

function sanitizeTeamName(raw: string): string {
  return stripHtml(raw)
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeTeam(value: string): boolean {
  if (!value || value.length < 2) return false;
  if (/\d/.test(value)) return false;
  if (!/\p{L}/u.test(value)) return false;
  return !isNoiseLabel(value);
}

// Минимальная нормализация имени: нижний регистр, без суффиксов FC/national team.
function normalizeTeamKey(value: string): string {
  return stripHtml(value)
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TEAM_SUFFIX_TOKENS.has(t))
    .join(' ');
}

function sameTeam(a: string, b: string): boolean {
  const ka = normalizeTeamKey(a);
  const kb = normalizeTeamKey(b);
  if (!ka || !kb) return false;
  return ka === kb;
}

// Строка-дата: ISO «2026-09-20» либо «20 Sep 2026» / «20 September 2026».
function parseDateLine(line: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(line)) return line;
  const human = line.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (human && human[2].slice(0, 3).toLowerCase() in MONTHS) return line;
  return null;
}

function dateToTimestamp(raw: string): number | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const ts = Date.parse(raw);
    return Number.isNaN(ts) ? null : ts;
  }
  const human = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (human) {
    const month = MONTHS[human[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return Date.UTC(Number(human[3]), month, Number(human[1]));
  }
  return null;
}

const MATCH_LINE_RE = /^(.+?)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(.+)$/;

interface ParsedMatchLine {
  teamA: string;
  teamB: string;
  goalsA: number;
  goalsB: number;
}

// «England 2-1 Germany», «England 2 - 1 Germany», «Germany 0–2 England».
// Требует счёт между двумя командами: «England vs Germany» и «Stats 2 1» не матчи.
function parseMatchLine(line: string): ParsedMatchLine | null {
  const m = line.match(MATCH_LINE_RE);
  if (!m) return null;
  const teamA = sanitizeTeamName(m[1]);
  const teamB = sanitizeTeamName(m[4]);
  if (!looksLikeTeam(teamA) || !looksLikeTeam(teamB)) return null;
  const goalsA = Number(m[2]);
  const goalsB = Number(m[3]);
  if (!Number.isFinite(goalsA) || !Number.isFinite(goalsB)) return null;
  if (goalsA > 99 || goalsB > 99) return null;
  return { teamA, teamB, goalsA, goalsB };
}

// Формат B: «Form: W W D L W» (разделители — пробел/запятая/;/|).
function parseFormLine(line: string): FormResult[] | null {
  const m = line.match(/^form\b\s*[:\-]?\s*(.+)$/i);
  if (!m) return null;
  const tokens = m[1]
    .split(/[\s,;|/]+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase());
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => t === 'W' || t === 'D' || t === 'L')) return null;
  return tokens as FormResult[];
}

/**
 * Извлекает подтверждённые последние матчи команды из cleaned text.
 *
 * Приоритет форматов: per-match строки (Форматы A/C) → при их отсутствии
 * компактная строка формы (Формат B, одна запись с summary).
 *
 * requestedTeam: результат считается относительно этой команды
 * (поддерживает «England», «England FC», «England national team»).
 * Без requestedTeam запись создаётся от первой команды строки.
 * Даты: сортировка newest → oldest только если датированы все матчи,
 * иначе исходный порядок. Максимум MAX_MATCHES записей.
 */
export function extractTeamFormFromText(
  text: string,
  requestedTeam?: string
): TeamFormSnapshot[] {
  if (typeof text !== 'string' || text.trim().length === 0) return [];

  const lines = text.split(/\r?\n/).map(normalizeLine).filter((l) => l.length > 0);
  const subject =
    typeof requestedTeam === 'string' && requestedTeam.trim().length > 0
      ? sanitizeTeamName(requestedTeam)
      : null;

  interface CollectedMatch {
    date: string | null;
    teamA: string;
    teamB: string;
    goalsA: number;
    goalsB: number;
  }
  const matches: CollectedMatch[] = [];
  let pendingDate: string | null = null;
  let formTokens: FormResult[] | null = null;

  for (const line of lines) {
    const dateStr = parseDateLine(line);
    if (dateStr) {
      pendingDate = dateStr;
      continue;
    }
    if (!formTokens) {
      const tokens = parseFormLine(line);
      if (tokens) {
        formTokens = tokens;
        continue;
      }
    }
    const parsed = parseMatchLine(line);
    if (parsed) {
      matches.push({ date: pendingDate, ...parsed });
      pendingDate = null;
    }
  }

  const entries: TeamFormSnapshot[] = [];
  for (const m of matches) {
    let team: string;
    let opponent: string | null;
    let goalsFor: number | null;
    let goalsAgainst: number | null;

    if (subject) {
      const aIsSubject = sameTeam(m.teamA, subject);
      const bIsSubject = sameTeam(m.teamB, subject);
      if (aIsSubject) {
        team = subject;
        opponent = m.teamB;
        goalsFor = m.goalsA;
        goalsAgainst = m.goalsB;
      } else if (bIsSubject) {
        team = subject;
        opponent = m.teamA;
        goalsFor = m.goalsB;
        goalsAgainst = m.goalsA;
      } else {
        continue;
      }
    } else {
      team = m.teamA;
      opponent = m.teamB;
      goalsFor = m.goalsA;
      goalsAgainst = m.goalsB;
    }

    let result: FormResult | null = null;
    if (goalsFor !== null && goalsAgainst !== null) {
      result = goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';
    }

    const summaryParts: string[] = [];
    if (result) summaryParts.push(result);
    if (goalsFor !== null && goalsAgainst !== null) {
      summaryParts.push(`${goalsFor}-${goalsAgainst}`);
    }
    if (opponent) summaryParts.push(`vs ${opponent}`);

    entries.push({
      team,
      summary: summaryParts.length > 0 ? summaryParts.join(' ') : null,
      date: m.date,
      opponent,
      result,
      goalsFor,
      goalsAgainst,
    });
  }

  if (entries.length === 0 && formTokens) {
    return [
      {
        team: subject ?? '',
        summary: formTokens.join(' '),
        date: null,
        opponent: null,
        result: null,
        goalsFor: null,
        goalsAgainst: null,
      },
    ];
  }

  if (entries.length > 1 && entries.every((e) => e.date)) {
    entries.sort(
      (x, y) => (dateToTimestamp(y.date as string) ?? 0) - (dateToTimestamp(x.date as string) ?? 0)
    );
  }

  return entries.slice(0, MAX_MATCHES);
}
